import type { Messages } from "../../core";

export const feedback = {
  title: "Feedback",
  "kind.label": "What is it about?",
  "kind.issue": "Something is not working",
  "kind.idea": "An idea or a wish",
  "kind.other": "Something else",
  "message.label": "Your message",
  "message.placeholder": "What happened, or what would help on your farm?",
  "email.label": "Your email (optional)",
  privacy:
    "Sent with your Orbit version and the type of computer. Your farm records are never included.",
  send: "Send feedback",
  sent: "Thank you. Your feedback was sent.",
  failed: "Could not send feedback",
  unavailable:
    "This Orbit is not connected to the Orbit cloud, so feedback cannot be sent from here.",
  "share.body":
    "Built a page or a connection with Orion that other farms could use? Ask Orion to share it. The Orbit team reviews it before anyone else can install it.",
  "share.action": "Share something I built",
  "share.prompt": "I want to share something we built with other farms",
  "shared.title": "What you have shared",
  "shared.status.pending": "In review",
  "shared.status.approved": "Approved",
  "shared.status.rejected": "Not accepted",
} as const satisfies Messages;
