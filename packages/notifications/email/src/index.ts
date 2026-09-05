import { emailDataSchema } from "@openstatus/db/src/schema";
import { EmailClient } from "@openstatus/emails/src/client";
import type { NotificationContext } from "@openstatus/notification-base";
import { getRegionInfo } from "@openstatus/regions";

import { env } from "../env";

export const sendAlert = async ({
  monitor,
  notification,
  statusCode,
  message,
  cronTimestamp,
  latency,
  regions,
}: NotificationContext) => {
  const region = regions?.[0];
  const emailClient = new EmailClient({ apiKey: env.RESEND_API_KEY });

  const config = emailDataSchema.parse(JSON.parse(notification.data));

  await emailClient.sendMonitorAlert({
    name: monitor.name,
    type: "alert",
    to: config.email,
    url: monitor.url,
    status: statusCode?.toString(),
    latency: latency ? `${latency}ms` : "N/A",
    region: region
      ? (getRegionInfo(region, { location: region }).location ?? region)
      : "N/A",
    timestamp: new Date(cronTimestamp).toISOString(),
    message,
  });
};

export const sendRecovery = async ({
  monitor,
  notification,
  statusCode,
  cronTimestamp,
  regions,
  latency,
}: NotificationContext) => {
  const region = regions?.[0];
  const emailClient = new EmailClient({ apiKey: env.RESEND_API_KEY });

  const config = emailDataSchema.parse(JSON.parse(notification.data));

  await emailClient.sendMonitorAlert({
    name: monitor.name,
    type: "recovery",
    to: config.email,
    url: monitor.url,
    status: statusCode?.toString(),
    latency: latency ? `${latency}ms` : "N/A",
    region: region
      ? (getRegionInfo(region, { location: region }).location ?? region)
      : "N/A",
    timestamp: new Date(cronTimestamp).toISOString(),
  });
};

export const sendDegraded = async ({
  monitor,
  notification,
  statusCode,
  cronTimestamp,
  regions,
  latency,
}: NotificationContext) => {
  const region = regions?.[0];
  const emailClient = new EmailClient({ apiKey: env.RESEND_API_KEY });

  const config = emailDataSchema.parse(JSON.parse(notification.data));

  await emailClient.sendMonitorAlert({
    name: monitor.name,
    type: "degraded",
    to: config.email,
    url: monitor.url,
    status: statusCode?.toString(),
    latency: latency ? `${latency}ms` : "N/A",
    region: region
      ? (getRegionInfo(region, { location: region }).location ?? region)
      : "N/A",
    timestamp: new Date(cronTimestamp).toISOString(),
  });
};
