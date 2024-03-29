import { Processor, Process, OnQueueError, OnQueueFailed } from '@nestjs/bull';
import { Logger } from '@nestjs/common';
import { Job } from 'bull';
import _ from 'lodash';
import { ICenterMini } from 'src/models/center.model';
import { ISubscriptionCollection } from 'src/models/subscriber.model';
import { AlertHandler } from 'src/utils/alerts.utils';
import { WhatsappService } from 'src/whatsapp.service';
import { BullQueueNames } from '../utils/config.utils';

@Processor(BullQueueNames.WHATSAPP_ALERTS)
export class WhatsappConsumer {
  constructor(private readonly whatsappService: WhatsappService) {}

  private getCenterByAge(centers: ICenterMini[], age) {
    const data: ICenterMini[] = [];
    centers.forEach((center) => {
      center.sessions = center.sessions.filter(
        (session) => _.eq(session.minAgeLimit, age) || _.eq(age, -1),
      );
      if (center.sessions.length > 0) data.push(center);
    });
    return data;
  }

  private getWhatsappMessage(grouped_centers: ICenterMini[][]) {
    const message = [];
    grouped_centers.forEach((center) => {
      message.push(
        ...[
          `*Name:* ${center[0].name}`,
          `*Address:* ${center[0].address}`,
          `*Pin Code:* ${center[0].pincode}`,
          `*Fee Type:* ${center[0].feeType}`,
          `*Age Group:* ${center[0].sessions[0].minAgeLimit}`,
        ],
      );
      const sessions = _.uniqBy(
        _.flatMap(center.map((sub_center) => sub_center.sessions)),
        'date',
      );
      message.push(
        `*Vaccines:* ${_.uniq(sessions.map((session) => session.vaccine)).join(
          ', ',
        )}`,
      );
      // message.push(
      //   `*Time Slots:* ${_.uniq(
      //     _.flatMapDeep(sessions.map((session) => session.slots)),
      //   ).join(', ')}`,
      // );
      message.push('*Availability:*');
      sessions.forEach((session, index) => {
        message.push(
          `\t\t\t\t\t\t\t\t\t\t\t*${index + 1}:*  ${session.date.replace(
            /-/g,
            '/',
          )} *-* ${session.availableCapacity} slots${
            _.eq(index, sessions.length - 1) ? '\n' : ''
          }`,
        );
      });
    });

    return message;
  }

  @Process()
  async sendMessage(job: Job<ISubscriptionCollection>) {
    const currentTime = new Date();

    const sendInavailability = currentTime.getHours() % 3 === 0;
    const client = await this.whatsappService.getClient();

    if (_.isNil(client?.isLoggedIn))
      throw new Error('Client not logged in jobs are stalling');

    // filter center by age
    if (!_.isNil(job.data.age)) {
      job.data.centers = this.getCenterByAge(job.data.centers, job.data.age);
    }

    // proceed if there is no message. AKA normal whatsapp notification for whatsapp nmessage
    if (_.isNil(job.data.message)) {
      if (!job.data.centers.length) {
        if (sendInavailability) {
          Logger.log('SENDING_INAVAILIBILITY_ALERTS', this.sendMessage.name);
          new AlertHandler().sendText('SENDING_INAVAILIBILITY_ALERTS');
          return await client.sendText(
            job.data.phoneNumber,
            `This is to notify you that there are no available slots at ${job.data.pincode} location yet. However we'll keep notifying you about the updates periodically.`,
          );
        }
        return true;
      } else {
        const message = this.getWhatsappMessage(
          _.values(_.groupBy(job.data.centers, 'center_id')),
        );

        return await client.sendText(job.data.phoneNumber, message.join('\n'));
      }
    } else return await client.sendText(job.data.phoneNumber, job.data.message);
  }

  @OnQueueFailed()
  async notifySlackFail(_, error: Error) {
    Logger.error(error, this.notifySlackFail.name);
    new AlertHandler().sendText('QUEUE_FALILED' + JSON.stringify(error));
  }

  @OnQueueError()
  async notifySlack(_, error: Error) {
    new AlertHandler().sendText('QUEUE_ERROR' + JSON.stringify(error));
  }
}
