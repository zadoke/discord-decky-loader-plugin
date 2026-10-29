import { ButtonItem, PanelSection, PanelSectionRow } from "@decky/ui";
import { useState } from "react";
import { FaArrowLeft, FaDesktop, FaStop, FaWindowMaximize } from "react-icons/fa";
import { DiscordState, ShareSource, shareSources, shareStart, shareStop } from "../backend";
import { useIsWindows } from "../platform";
import { showError, StatusLine } from "./common";

// Same keys as QUALITIES in py_modules/screenshare.py.
const QUALITIES = ["720p30", "1080p30", "1080p60"];
const QUALITY_KEY = "discord-deck:share-quality";

const loadQuality = () => {
  try {
    const saved = localStorage.getItem(QUALITY_KEY);
    return saved && QUALITIES.includes(saved) ? saved : "720p30";
  } catch {
    return "720p30";
  }
};

// Windows only for now, and only in a call.
export function ScreenShare({ state }: { state: DiscordState }) {
  const isWindows = useIsWindows();
  if (!isWindows || !state.voice) return null;
  return <SharePanel state={state} />;
}

function SharePanel({ state }: { state: DiscordState }) {
  const share = state.share ?? { status: "idle" };
  const [sources, setSources] = useState<ShareSource[] | null>(null);
  const [quality, setQuality] = useState(loadQuality);

  const nextQuality = () => {
    const next = QUALITIES[(QUALITIES.indexOf(quality) + 1) % QUALITIES.length];
    setQuality(next);
    try {
      localStorage.setItem(QUALITY_KEY, next);
    } catch {
      /* only remembered for this session */
    }
  };

  const openPicker = () => shareSources().then(setSources).catch(showError);

  const start = (source: ShareSource) => {
    setSources(null);
    shareStart(source.id, quality).catch(showError);
  };

  const stopButton = (label: string) => (
    <PanelSectionRow>
      <ButtonItem layout="below" onClick={() => shareStop().catch(showError)}>
        <FaStop /> {label}
      </ButtonItem>
    </PanelSectionRow>
  );

  if (share.status === "downloading") {
    const pct = Math.round((share.progress ?? 0) * 100);
    return (
      <PanelSection title="Screen share">
        <StatusLine step="Getting ready" text={`Downloading ffmpeg, only needed once (${pct}%).`} />
        {stopButton("Cancel")}
      </PanelSection>
    );
  }

  if (share.status === "starting") {
    return (
      <PanelSection title="Screen share">
        <StatusLine step="Starting" text={`Capturing with ${share.encoder} and starting Go Live…`} />
        {stopButton("Cancel")}
      </PanelSection>
    );
  }

  if (share.status === "live" || state.streaming) {
    return (
      <PanelSection title="Screen share">
        <StatusLine step="You're live" text={share.encoder ? `${share.quality} · ${share.encoder}` : undefined} />
        {stopButton("Stop sharing")}
      </PanelSection>
    );
  }

  if (sources) {
    const monitors = sources.filter((s) => s.kind === "monitor");
    const windows = sources.filter((s) => s.kind === "window");
    return (
      <PanelSection title="Share what?">
        <PanelSectionRow>
          <ButtonItem layout="below" onClick={() => setSources(null)}>
            <FaArrowLeft /> Back
          </ButtonItem>
        </PanelSectionRow>
        <PanelSectionRow>
          <ButtonItem layout="below" onClick={nextQuality}>
            Quality: {quality}
          </ButtonItem>
        </PanelSectionRow>
        {[...monitors, ...windows].map((s) => (
          <PanelSectionRow key={s.id}>
            <ButtonItem layout="below" description={s.detail} onClick={() => start(s)}>
              {s.kind === "monitor" ? <FaDesktop /> : <FaWindowMaximize />} {s.label}
            </ButtonItem>
          </PanelSectionRow>
        ))}
      </PanelSection>
    );
  }

  return (
    <PanelSection title="Screen share">
      {share.status === "error" && <StatusLine step="Screen share stopped" text={share.error} />}
      <PanelSectionRow>
        <ButtonItem layout="below" onClick={openPicker}>
          <FaDesktop /> Share screen
        </ButtonItem>
      </PanelSectionRow>
    </PanelSection>
  );
}
