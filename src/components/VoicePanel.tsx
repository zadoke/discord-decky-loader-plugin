import {
  ButtonItem,
  PanelSection,
  PanelSectionRow,
  ToggleField,
} from "@decky/ui";
import { toaster } from "@decky/api";
import { useEffect, useState } from "react";
import {
  FaArrowLeft,
  FaHeadphones,
  FaMicrophone,
  FaMicrophoneSlash,
  FaPhoneSlash,
  FaVolumeMute,
  FaVolumeUp,
} from "react-icons/fa";
import { command, DiscordState, Guild, VoiceChannel } from "../backend";
import { OpenDiscordButton, run, StatusLine } from "./common";
import { ScreenShare } from "./ScreenShare";
import { SignIn } from "./SignIn";
import { useFamilyViewLocked } from "../familyView";
import { checkLoadStall, startDiscord } from "../lifecycle";
import { useSecondsSince, useStartupPhase } from "../startup";
import { applyPttSettings, loadPttSettings, PTT_BUTTONS, PttSettings } from "../pushToTalk";
import { useIsWindows } from "../platform";

// Waits for Discord to report the voice channel we asked for. Polled from here
// because timers inside the hidden Discord page are throttled.
async function confirmVoiceChannel(
  channelId: string | null,
  onState?: (s: DiscordState) => void,
  attempts = 16,
) {
  let last: DiscordState | null = null;
  for (let i = 0; i < attempts; i++) {
    last = await command<DiscordState>("state").catch(() => last);
    if (last) onState?.(last);
    if ((last?.voice?.channelId ?? null) === channelId) return { ok: true, last };
    if (last?.joinError) return { ok: false, last };
    await new Promise((r) => setTimeout(r, 500));
  }
  return { ok: false, last };
}

// The join in progress, shared so the panel shows it even after reopening.
interface Joining {
  channelId: string;
  name: string;
  since: number;
  step: string;
}
let joining: Joining | null = null;
const joiningListeners = new Set<(j: Joining | null) => void>();
const setJoining = (next: Joining | null) => {
  joining = next;
  joiningListeners.forEach((l) => l(joining));
};

function useJoining() {
  const [value, setValue] = useState(joining);
  useEffect(() => {
    setValue(joining);
    joiningListeners.add(setValue);
    return () => void joiningListeners.delete(setValue);
  }, []);
  return value;
}

// What Discord is doing right now, in words, while a join is in progress.
function joinStep(s: DiscordState, channelId: string) {
  if (s.mic?.status === "requesting") return "Getting your microphone…";
  if (s.voice?.channelId === channelId) return "Connecting to voice…";
  return "Asking Discord to join…";
}

async function joinVoice(channel: VoiceChannel) {
  if (joining) return;
  setJoining({ channelId: channel.id, name: channel.name, since: Date.now(), step: "Asking Discord to join…" });
  try {
    if ((await run("join", { channelId: channel.id })) === undefined) return;
    // Up to 30s: the first join also sets up the microphone relay.
    const { ok, last } = await confirmVoiceChannel(
      channel.id,
      (s) => joining && setJoining({ ...joining, step: joinStep(s, channel.id) }),
      60,
    );
    if (ok) return;
    let body = "Discord didn't accept the join request. Open full Discord to see if it's asking for something.";
    if (last?.joinError) {
      body = `Discord couldn't join: ${last.joinError}`;
    } else if (last?.mic?.status === "failed") {
      body = `Discord couldn't get your microphone, so it didn't join. ${last.mic.error ?? ""}`.trim();
    } else if (last?.mic?.status === "requesting") {
      body = "Discord is still waiting for your microphone, so it didn't join. Try again.";
    }
    toaster.toast({ title: "Discord", body });
  } finally {
    setJoining(null);
  }
}

async function leaveVoice() {
  if ((await run("disconnect")) === undefined) return;
  if (!(await confirmVoiceChannel(null))) {
    toaster.toast({ title: "Discord", body: "Discord didn't leave the call. Try again." });
  }
}

function CurrentCall({ state }: { state: DiscordState }) {
  const voice = state.voice;
  if (!voice) {
    return (
      <PanelSection title="Voice">
        <PanelSectionRow>
          <div>Not in a voice channel.</div>
        </PanelSectionRow>
      </PanelSection>
    );
  }

  const connecting = !!state.rtc && state.rtc !== "RTC_CONNECTED";

  return (
    <PanelSection title={voice.guildName ? `${voice.channelName} · ${voice.guildName}` : voice.channelName}>
      {connecting && (
        <PanelSectionRow>
          <div>Connecting to voice…</div>
        </PanelSectionRow>
      )}
      {state.muted && state.mic?.status === "failed" && (
        <StatusLine
          step="No microphone"
          text={`Discord couldn't get a microphone, so it keeps you muted. Plug one in, then tap Unmute. ${state.mic.error ?? ""}`.trim()}
        />
      )}
      <PanelSectionRow>
        <ButtonItem layout="below" onClick={() => run("toggleMute")}>
          {state.muted ? <><FaMicrophoneSlash /> Unmute</> : <><FaMicrophone /> Mute</>}
        </ButtonItem>
      </PanelSectionRow>
      <PanelSectionRow>
        <ButtonItem layout="below" onClick={() => run("toggleDeafen")}>
          {state.deafened ? <><FaVolumeMute /> Undeafen</> : <><FaHeadphones /> Deafen</>}
        </ButtonItem>
      </PanelSectionRow>
      <PanelSectionRow>
        <ButtonItem layout="below" onClick={leaveVoice}>
          <FaPhoneSlash /> Leave call
        </ButtonItem>
      </PanelSectionRow>
      {voice.members.map((m) => (
        <PanelSectionRow key={m.id}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span>{m.name}</span>
            <span>
              {m.deafened ? <FaVolumeMute /> : m.muted ? <FaMicrophoneSlash /> : <FaVolumeUp />}
            </span>
          </div>
        </PanelSectionRow>
      ))}
    </PanelSection>
  );
}

const LAST_GUILD_KEY = "discord-deck:last-guild";

function JoinVoice({ currentChannelId }: { currentChannelId?: string }) {
  const [guilds, setGuilds] = useState<Guild[]>([]);
  const [guildId, setGuildId] = useState<string | null>(localStorage.getItem(LAST_GUILD_KEY));
  const [channels, setChannels] = useState<VoiceChannel[]>([]);

  useEffect(() => {
    run("guilds").then((g) => setGuilds((g as Guild[] | null) ?? []));
  }, []);

  useEffect(() => {
    if (!guildId) {
      localStorage.removeItem(LAST_GUILD_KEY);
      setChannels([]);
      return;
    }
    localStorage.setItem(LAST_GUILD_KEY, guildId);
    run("voiceChannels", { guildId }).then((c) => setChannels((c as VoiceChannel[] | null) ?? []));
  }, [guildId, currentChannelId]);

  const guild = guilds.find((g) => g.id === guildId);
  const pending = useJoining();
  const seconds = useSecondsSince(pending?.since);

  // A plain list of buttons instead of a dropdown: it's easier to drive with the
  // D-pad, and Steam's dropdown didn't register selections inside this panel.
  if (!guildId) {
    return (
      <PanelSection title="Join a voice channel">
        {guilds.length === 0 && (
          <PanelSectionRow>
            <div>Loading servers…</div>
          </PanelSectionRow>
        )}
        {guilds.map((g) => (
          <PanelSectionRow key={g.id}>
            <ButtonItem layout="below" onClick={() => setGuildId(g.id)}>
              {g.name}
            </ButtonItem>
          </PanelSectionRow>
        ))}
      </PanelSection>
    );
  }

  return (
    <PanelSection title={guild ? `Voice channels · ${guild.name}` : "Voice channels"}>
      <PanelSectionRow>
        <ButtonItem layout="below" onClick={() => setGuildId(null)}>
          <FaArrowLeft /> Pick another server
        </ButtonItem>
      </PanelSectionRow>
      {pending && (
        <StatusLine step={`Joining ${pending.name}`} text={`${pending.step} (${seconds}s)`} />
      )}
      {channels.length === 0 && (
        <PanelSectionRow>
          <div>No voice channels you can see here.</div>
        </PanelSectionRow>
      )}
      {channels.map((c) => (
        <PanelSectionRow key={c.id}>
          <ButtonItem
            layout="below"
            disabled={!!pending || c.id === currentChannelId}
            onClick={() => joinVoice(c)}
          >
            <FaVolumeUp /> {pending?.channelId === c.id ? "Joining… " : ""}{c.name}
            {c.memberCount > 0 ? ` (${c.memberCount})` : ""}
          </ButtonItem>
        </PanelSectionRow>
      ))}
    </PanelSection>
  );
}

function PushToTalk() {
  const [settings, setSettings] = useState<PttSettings>(loadPttSettings);

  const update = (next: PttSettings) => {
    setSettings(next);
    applyPttSettings(next).catch((e) => toaster.toast({ title: "Discord", body: String(e) }));
  };

  // Cycles R4 → R5 → L4 → L5 on each press.
  const nextButton = () => {
    const i = PTT_BUTTONS.findIndex((b) => b.data === settings.button);
    update({ ...settings, button: PTT_BUTTONS[(i + 1) % PTT_BUTTONS.length].data });
  };

  return (
    <PanelSection title="Push to talk">
      <PanelSectionRow>
        <ToggleField
          label="Push to talk"
          description="Hold a back button to talk."
          checked={settings.enabled}
          onChange={(enabled) => update({ ...settings, enabled })}
        />
      </PanelSectionRow>
      {settings.enabled && (
        <PanelSectionRow>
          <ButtonItem layout="below" onClick={nextButton}>
            Talk button: {PTT_BUTTONS.find((b) => b.data === settings.button)?.label ?? "R5"}
          </ButtonItem>
        </PanelSectionRow>
      )}
    </PanelSection>
  );
}

// Startup progress, one clear step at a time. Discord restarts itself once if
// loading stalls, so the user only has to act if that also fails.
function Starting({ state }: { state: DiscordState }) {
  const phase = useStartupPhase();
  const seconds = useSecondsSince(phase.kind === "loading" ? phase.since : undefined);

  // The panel re-renders every second while loading, so it doubles as a
  // backup trigger for the stall check.
  useEffect(() => {
    if (phase.kind === "loading") checkLoadStall();
  }, [phase, seconds]);

  if (phase.kind === "error") {
    return (
      <PanelSection title="Discord">
        <StatusLine step="Something went wrong" text={phase.message} />
        <PanelSectionRow>
          <ButtonItem layout="below" onClick={() => startDiscord()}>
            Try again
          </ButtonItem>
        </PanelSectionRow>
      </PanelSection>
    );
  }

  let step = "Step 1 of 3: Preparing";
  let text = "Setting up a hidden window for Discord.";
  if (phase.kind === "connecting") {
    step = "Step 2 of 3: Connecting";
    text = "Hooking the plugin up to the Discord window.";
  } else if (phase.kind === "loading" || state.attached) {
    step = "Step 3 of 3: Opening Discord";
    const page = state.page ?? {};
    if (!page.url?.startsWith("https://discord.com")) {
      text = "Opening discord.com.";
    } else if (!page.loaded) {
      text = "Loading discord.com. It's quicker after the first time.";
    } else {
      text = "Discord's page is open. Waiting for Discord to finish starting.";
    }
    if (phase.kind === "loading" && phase.retried) {
      text = `That took too long, so Discord was restarted. ${text}`;
    }
    if (phase.kind === "loading") text += ` (${seconds}s)`;
  }

  return (
    <PanelSection title="Discord">
      <StatusLine step={step} text={text} />
    </PanelSection>
  );
}

function FamilyViewNotice() {
  return (
    <PanelSection title="Family View is on">
      <PanelSectionRow>
        <div>
          Discord can't open while Steam Family View is on. Unlock Family View with your PIN,
          then come back here.
        </div>
      </PanelSectionRow>
    </PanelSection>
  );
}

function SignedIn({ state }: { state: DiscordState }) {
  const isWindows = useIsWindows();
  return (
    <PanelSection title={`Signed in as ${state.user?.name ?? ""}`}>
      {!isWindows && (
        <>
          <PanelSectionRow>
            <div style={{ opacity: 0.8 }}>
              For anything this panel can't do yet, like text chat, open the full Discord app.
            </div>
          </PanelSectionRow>
          <OpenDiscordButton label="Open full Discord" />
        </>
      )}
    </PanelSection>
  );
}

export function VoicePanel({ state }: { state: DiscordState }) {
  const familyViewLocked = useFamilyViewLocked();
  if (familyViewLocked) return <FamilyViewNotice />;

  if (!state.attached || !state.ready) {
    return <Starting state={state} />;
  }

  if (!state.loggedIn) return <SignIn state={state} />;

  return (
    <>
      <CurrentCall state={state} />
      <ScreenShare state={state} />
      <JoinVoice currentChannelId={state.voice?.channelId} />
      <PushToTalk />
      <SignedIn state={state} />
    </>
  );
}
