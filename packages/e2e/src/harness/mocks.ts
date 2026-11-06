import { MockTelegram } from "@relay/channels/testing";
import { Secret } from "@relay/shared";
import { SwitchClient } from "@relay/switch";
import { MockSwitch } from "@relay/switch/testing";
import { MockGitHub } from "@relay/trackers/testing";
import { MockGemini } from "./mock-gemini.js";

/** Every external system the platform talks to, as a local mock. Nothing here touches the internet. */
export interface Mocks {
  github: MockGitHub;
  gemini: MockGemini;
  telegram: MockTelegram;
  switchGateway: MockSwitch;
  /** Production hostnames the real processes use, mapped to the mock that stands in for them (see the preload shim). */
  hostMap: Record<string, string>;
  /** API key of the notifier agent the mock Switch issued. */
  notifierKey: string;
  reset(): void;
  stop(): Promise<void>;
}

export async function startMocks(): Promise<Mocks> {
  const github = new MockGitHub();
  const gemini = new MockGemini();
  const telegram = new MockTelegram();
  const switchGateway = new MockSwitch();
  await Promise.all([github.start(), gemini.start(), telegram.start(), switchGateway.start()]);

  // Switch needs its two agents before rooms can be created; the real setup does this with `npm run switch:bootstrap`.
  const admin = new SwitchClient({ gatewayUrl: switchGateway.gatewayUrl, email: switchGateway.email, password: new Secret(switchGateway.password) });
  await admin.registerAgent({ name: "relay-triager", description: "triages tickets", displayName: "Triager" });
  const notifierKey = (await admin.registerAgent({ name: "relay-notifier", description: "pings owners", displayName: "Notifier" })).apiKey.reveal();
  switchGateway.knownUsers.add("pat.pm");

  return {
    github, gemini, telegram, switchGateway, notifierKey,
    hostMap: {
      "api.github.com": github.url,
      "api.telegram.org": telegram.url,
      "generativelanguage.googleapis.com": gemini.url,
    },
    // The Switch mock keeps its agents and sessions (set up once); only what a scenario produced is cleared.
    reset() {
      github.reset(); gemini.reset(); telegram.reset();
      switchGateway.rooms.length = 0; switchGateway.messages.length = 0; switchGateway.requests.length = 0;
    },
    async stop() { await Promise.all([github.stop(), gemini.stop(), telegram.stop(), switchGateway.stop()]); },
  };
}
