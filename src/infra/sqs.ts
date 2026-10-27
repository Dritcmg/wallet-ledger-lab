import {
  SQSClient, CreateQueueCommand, GetQueueUrlCommand, GetQueueAttributesCommand,
  SetQueueAttributesCommand, SendMessageCommand,
} from '@aws-sdk/client-sqs';
import { config } from '../config';

export interface PublishableEvent { eventId: string; aggregateId: string; [key: string]: unknown }
export class SqsBroker {
  readonly client: SQSClient;
  inputQueueUrl = '';
  dlqUrl = '';
  eventsQueueUrl = '';

  constructor(client?: SQSClient) {
    this.client = client ?? new SQSClient({
      region: config.awsRegion, endpoint: config.sqsEndpoint, maxAttempts: 3,
      credentials: { accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? 'local', secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? 'local' },
      requestHandler: { connectionTimeout: 2000, requestTimeout: 15000 },
    });
  }

  async initialize(): Promise<void> {
    const urls = await Promise.all([config.queueName, config.dlqName, config.eventsQueueName].map(async QueueName => {
      const response = await this.client.send(new GetQueueUrlCommand({ QueueName }));
      if (!response.QueueUrl) throw new Error('SQS did not return a queue URL.');
      return response.QueueUrl;
    }));
    this.inputQueueUrl = urls[0]!; this.dlqUrl = urls[1]!; this.eventsQueueUrl = urls[2]!;
  }

  async provision(): Promise<void> {
    // Provisioning is explicit and restricted to the local development broker.
    const hostname = new URL(config.sqsEndpoint).hostname;
    if (!['localhost', '127.0.0.1', '::1', '[::1]', 'localstack', 'localstack-test', 'ministack'].includes(hostname)) {
      throw new Error('Automatic SQS provisioning is restricted to a local broker.');
    }
    const dlq = await this.client.send(new CreateQueueCommand({ QueueName: config.dlqName, Attributes: {
      FifoQueue: 'true', ContentBasedDeduplication: 'false', MessageRetentionPeriod: '1209600',
    } }));
    if (!dlq.QueueUrl) throw new Error('SQS did not return the DLQ URL.');
    const attributes = await this.client.send(new GetQueueAttributesCommand({ QueueUrl: dlq.QueueUrl, AttributeNames: ['QueueArn'] }));
    const arn = attributes.Attributes?.QueueArn;
    if (!arn) throw new Error('SQS did not return the DLQ ARN.');
    const input = await this.client.send(new CreateQueueCommand({ QueueName: config.queueName, Attributes: {
      FifoQueue: 'true', ContentBasedDeduplication: 'false', MessageRetentionPeriod: '1209600', VisibilityTimeout: String(config.sqsVisibilitySeconds),
    } }));
    if (!input.QueueUrl) throw new Error('SQS did not return the input queue URL.');
    await this.client.send(new SetQueueAttributesCommand({ QueueUrl: input.QueueUrl, Attributes: {
      RedrivePolicy: JSON.stringify({ deadLetterTargetArn: arn, maxReceiveCount: String(config.sqsMaxAttempts) }),
    } }));
    await this.client.send(new CreateQueueCommand({ QueueName: config.eventsQueueName, Attributes: {
      FifoQueue: 'true', ContentBasedDeduplication: 'false', MessageRetentionPeriod: '1209600',
    } }));
    await this.initialize();
  }

  async health(): Promise<void> {
    if (!this.inputQueueUrl || !this.dlqUrl || !this.eventsQueueUrl) throw new Error('SQS is not initialized.');
    await Promise.all([this.inputQueueUrl, this.dlqUrl, this.eventsQueueUrl].map(QueueUrl => this.client.send(new GetQueueAttributesCommand({ QueueUrl, AttributeNames: ['QueueArn'] }))));
  }

  async publishEvent(event: PublishableEvent): Promise<void> {
    if (!this.eventsQueueUrl) throw new Error('SQS is not initialized.');
    await this.client.send(new SendMessageCommand({
      QueueUrl: this.eventsQueueUrl, MessageBody: JSON.stringify(event),
      MessageDeduplicationId: event.eventId, MessageGroupId: event.aggregateId,
    }));
  }

  async deadLetterDepth(): Promise<number> {
    const response = await this.client.send(new GetQueueAttributesCommand({
      QueueUrl: this.dlqUrl, AttributeNames: ['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible'],
    }), { abortSignal: AbortSignal.timeout(2000) });
    return Number(response.Attributes?.ApproximateNumberOfMessages ?? 0)
      + Number(response.Attributes?.ApproximateNumberOfMessagesNotVisible ?? 0);
  }

  close(): void { this.client.destroy(); }
}
