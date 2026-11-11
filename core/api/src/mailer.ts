// Transactional email: verification, password reset, invites, purchase receipts.
// `log` (the default outside production) prints each message instead of sending it.

import { planFor } from "./plans";
import type { FetchLike } from "./shape";

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  template: string;
}

export interface Mailer {
  send(message: EmailMessage): Promise<void>;
}

export interface MailerConfig {
  provider?: string;
  apiKey?: string;
  from?: string;
  fetch?: FetchLike;
}

export class MailerError extends Error {}

export function createLogMailer(
  write: (line: string) => void = (line) => console.log(line),
): Mailer & { sent: EmailMessage[] } {
  const sent: EmailMessage[] = [];
  return {
    sent,
    async send(message) {
      sent.push(message);
      write(
        `[mail:${message.template}] to=${message.to} subject=${JSON.stringify(message.subject)}\n${message.text}`,
      );
    },
  };
}

function createResendMailer(apiKey: string, from: string, doFetch: FetchLike): Mailer {
  return {
    async send(message) {
      const res = await doFetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({
          from,
          to: [message.to],
          subject: message.subject,
          text: message.text,
          tags: [{ name: "template", value: message.template }],
        }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) throw new MailerError(`resend answered ${res.status}: ${await res.text()}`);
    },
  };
}

function createPostmarkMailer(apiKey: string, from: string, doFetch: FetchLike): Mailer {
  return {
    async send(message) {
      const res = await doFetch("https://api.postmarkapp.com/email", {
        method: "POST",
        headers: {
          "x-postmark-server-token": apiKey,
          accept: "application/json",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          From: from,
          To: message.to,
          Subject: message.subject,
          TextBody: message.text,
          Tag: message.template,
          MessageStream: "outbound",
        }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) throw new MailerError(`postmark answered ${res.status}: ${await res.text()}`);
    },
  };
}

export function createMailer(config: MailerConfig): Mailer {
  const provider = config.provider || "log";
  if (provider === "log") return createLogMailer();
  const doFetch = config.fetch ?? ((input, init) => fetch(input, init));
  if (!config.apiKey || !config.from) {
    throw new MailerError(`MAIL_PROVIDER=${provider} needs MAIL_API_KEY and MAIL_FROM`);
  }
  if (provider === "resend") return createResendMailer(config.apiKey, config.from, doFetch);
  if (provider === "postmark") return createPostmarkMailer(config.apiKey, config.from, doFetch);
  throw new MailerError(`unknown MAIL_PROVIDER ${provider}`);
}

export interface EmailLinks {
  /** Public website origin, e.g. https://pecorva.com; links land on its /account/ page. */
  siteUrl: string;
  downloadUrl: string;
}

const accountLink = (links: EmailLinks, query: Record<string, string>) => {
  const search = new URLSearchParams(query).toString();
  return `${links.siteUrl.replace(/\/+$/, "")}/account/${search ? `?${search}` : ""}`;
};

export const emails = {
  verify(links: EmailLinks, to: string, token: string): EmailMessage {
    return {
      to,
      template: "verify_email",
      subject: "Confirm your Pecorva email address",
      text: `Confirm your email address to finish setting up your Pecorva account:\n\n${accountLink(links, { verify: token })}\n\nThe link works for 48 hours. If you did not create an account, ignore this email.`,
    };
  },
  reset(links: EmailLinks, to: string, token: string): EmailMessage {
    return {
      to,
      template: "password_reset",
      subject: "Reset your Pecorva password",
      text: `Someone asked to reset the password for ${to}. Choose a new password here:\n\n${accountLink(links, { reset: token })}\n\nThe link works for one hour and signs you out everywhere else. If it was not you, ignore this email; your password stays the same.`,
    };
  },
  passwordChanged(to: string): EmailMessage {
    return {
      to,
      template: "password_changed",
      subject: "Your Pecorva password was changed",
      text: `The password for ${to} was just changed and every device was signed out. If this was not you, reset your password right away and contact support.`,
    };
  },
  invite(
    links: EmailLinks,
    to: string,
    farmName: string,
    role: string,
    code: string,
  ): EmailMessage {
    return {
      to,
      template: "farm_invite",
      subject: `You are invited to ${farmName} on Pecorva`,
      text: `You have been invited to join ${farmName} as ${role}.\n\n1. Install Orbit: ${links.downloadUrl}\n2. Sign in or create an account with this email address (${to}).\n3. In Settings > Account, enter this invite code:\n\n${code}\n\nThe invite works for 7 days.`,
    };
  },
  planActive(links: EmailLinks, to: string, plan: string, interval: string): EmailMessage {
    const name = planFor(plan).name;
    return {
      to,
      template: "plan_active",
      subject: `Your Pecorva ${name} plan is active`,
      text: `Thanks! Your ${name} plan (${interval === "year" ? "yearly" : "monthly"}) is active and Orion is ready on Pecorva's cloud.\n\nNext steps:\n1. Install Orbit on the farm PC: ${links.downloadUrl}\n2. Open Settings > Account and sign in with ${to}.\n3. Ask Orion anything about your herd. Your monthly Orion allowance is included in the plan.\n\nManage or cancel your plan any time: ${accountLink(links, {})}`,
    };
  },
  hardwareOrder(links: EmailLinks, to: string, boxes: number, cameras: number): EmailMessage {
    return {
      to,
      template: "hardware_order",
      subject: "Your Pecorva order is confirmed",
      text: `Thanks for your order: ${boxes} Pecorva box(es) and ${cameras} camera(s). We will email tracking details when it ships.\n\nWhile you wait, install Orbit on the farm PC (${links.downloadUrl}) and create your account at ${accountLink(links, {})} with ${to}.`,
    };
  },
  orderNotice(
    to: string,
    sessionId: string,
    boxes: number,
    cameras: number,
    buyer: string | null,
  ): EmailMessage {
    return {
      to,
      template: "order_notice",
      subject: `New hardware order ${sessionId}`,
      text: `Paid hardware order ${sessionId}: ${boxes} box(es), ${cameras} camera(s), buyer ${buyer ?? "unknown"}. Shipping details are in Stripe and the hardware_orders table.`,
    };
  },
};
