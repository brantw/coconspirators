import 'reflect-metadata';
import { EventEmitter } from 'events';
import { AmqpClient } from './client';
import { NAME_KEY, QueueOptions, PublishOptions, SubscribeOptions, ReplyOptions } from './types';
import * as amqp from 'amqplib';
import * as shortid from 'shortid';

export class AmqpQueue<T> extends EventEmitter {

  queue: any;
  rpcQueue: any;
  options: QueueOptions = {
    durable: false,
    noAck: true
  };

  constructor(private client: AmqpClient, options?: QueueOptions) {
    super();

    // if decorated, get decorations and merge
    const metadata = Reflect.getMetadata(NAME_KEY, this);
    if(metadata) {
      Object.assign(this.options, metadata);
    }

    // if options passed in manually, extend options
    if(options) {
      Object.assign(this.options, options);
    }

    this.queue = this.createQueue();
  }

  async subscribe(callback: (message: T) => {}, options: SubscribeOptions = {}): Promise<any> {
    const chnl = await this.client.channel;
    const opts: any = { ...this.options, ...options };

    if (options.prefetch) {
      chnl.prefetch(options.prefetch);
    }

    return chnl.consume(this.options.name, async (message: any) => {
      if(opts.contentType === 'application/json') {
        message.content = JSON.parse(message.content.toString());
      }

      message.reply = (content: any, replyOptions: ReplyOptions = {}) => {
        replyOptions.replyTo = message.properties.replyTo;
        replyOptions.correlationId = message.properties.correlationId;
        return this.reply(content, replyOptions);
      };

      message.ack = () => {
        this.ack(message);
      };

      callback(message);
    }, opts);
  }

  async publish(content: any, options: PublishOptions = {}): Promise<any> {
    const chnl = await this.client.channel;
    const opts: any = { ...this.options, ...options};

    if(this.rpcQueue) {
      const correlationId = shortid.generate();
      opts.correlationId = correlationId;
      opts.replyTo = this.rpcQueue.queue;
    }

    if(opts.contentType === 'application/json') {
      const json = JSON.stringify(content);
      content = new Buffer(json);
    }

    chnl.sendToQueue(this.options.name, content, opts);

    return {
      content,
      properties: opts
    };
  }

  async replyOf(idOrMessage: string|any): Promise<any> {
    let id = idOrMessage;
    if(typeof id !== 'string') {
      id = idOrMessage.properties.correlationId;
    }

    return new Promise((resolve, reject) => {
      this.once(id, (message: amqp.Message) => {
        if(this.options.contentType === 'application/json') {
          try {
            message.content = JSON.parse(message.content.toString());
          } catch(e) { /* do nothing */ }
        }
        resolve(message);
      });
    });
  }

  async reply(content: any, options: ReplyOptions = {}): Promise<any> {
    const chnl = await this.client.channel;

    if(this.options.contentType === 'application/json') {
      const json = JSON.stringify(content);
      content = new Buffer(json);
    }

    chnl.sendToQueue(options.replyTo, content, options);

    return {
      content,
      properties: options
    };
  }

  async ack(message: amqp.Message): Promise<void> {
    const chnl = await this.client.channel;
    chnl.ack(message);
  }

  async purge(): Promise<any> {
    const chnl = await this.client.channel;
    return chnl.purgeQueue(this.options.name);
  }

  private createQueue(): Promise<any> {
    return new Promise(async (resolve, reject) => {
      try {
        const conn = await this.client.connection;
        const chnl = await this.client.channel;
        const queue = await chnl.assertQueue(this.options.name, this.options);

        await this.consumeReplies();
        resolve(queue);
      } catch(e) {
        reject(e);
      }
    });
  }

  private async consumeReplies(): Promise<void> {
    if(!this.options.rpc) return;

    const chnl = await this.client.channel;
    this.rpcQueue = await chnl.assertQueue('', { 
      exclusive: this.options.exclusive 
    });
    
    chnl.consume(this.rpcQueue.queue, (result) => {
      this.emit(result.properties.correlationId, result);
    }, { noAck: true });
  }
  
}
