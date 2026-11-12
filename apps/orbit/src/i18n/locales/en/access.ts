import type { Messages } from "../../core";

export const access = {
  title: "Let Orion lend a hand on this computer?",
  "lead.shell": "To get this done, Orion would like to run a command on your computer.",
  "lead.browser": "To get this done, Orion would like to use a web browser.",
  "lead.computer":
    "To get this done, Orion would like to see your screen and use the mouse and keyboard.",
  "point.commands": "Run commands and small programs to build and fix things for your farm.",
  "point.browser": "Use a web browser to look things up and fill in forms.",
  "point.screen":
    "Operate other programs on screen when there is no other way in, just like you would.",
  "point.asks":
    "Orion tells you what it is doing and checks with you before anything big, like deleting or installing.",
  risk: "Orbit is free, open-source software, provided as is. Orion is helpful but can make mistakes, so by allowing it you accept the risk of what it does on this computer. You can turn this off any time in Settings.",
  allow: "Allow Orion",
  decline: "Not now",
} satisfies Messages;
