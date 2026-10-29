import { ButtonItem, PanelSection, PanelSectionRow } from "@decky/ui";
import { useMemo } from "react";
import qrcode from "qrcode-generator";
import { DiscordState } from "../backend";
import { useIsWindows } from "../platform";
import { OpenDiscordButton, run, StatusLine } from "./common";

// Draws the login page's QR link as an image, so signing in works even where
// the Discord view can't be shown (Big Picture on Windows).
function QrCode({ url }: { url: string }) {
  const src = useMemo(() => {
    const qr = qrcode(0, "M");
    qr.addData(url);
    qr.make();
    return qr.createDataURL(8, 4);
  }, [url]);
  return (
    <img
      src={src}
      alt="Discord sign-in QR code"
      style={{ display: "block", width: "100%", maxWidth: 240, margin: "0 auto", imageRendering: "pixelated" }}
    />
  );
}

function SignInStep({ qr }: { qr: DiscordState["qr"] }) {
  if (qr?.scanned) {
    return <StatusLine step="Check your phone" text="Confirm the sign-in in the Discord app." />;
  }
  if (!qr?.url) {
    return <StatusLine step="Sign in needed" text="Getting a sign-in code from Discord…" />;
  }
  return (
    <>
      <StatusLine
        step="Sign in needed"
        text="In the Discord app on your phone, go to Settings › Scan QR Code and scan this. You only need to do this once."
      />
      <PanelSectionRow>
        <QrCode url={qr.url} />
      </PanelSectionRow>
    </>
  );
}

export function SignIn({ state }: { state: DiscordState }) {
  const isWindows = useIsWindows();
  return (
    <PanelSection title="Discord">
      <SignInStep qr={state.qr} />
      <PanelSectionRow>
        <ButtonItem layout="below" onClick={() => run("reload")}>
          Get a new code
        </ButtonItem>
      </PanelSectionRow>
      {/* Big Picture on Windows doesn't draw the Discord view, so it'd just be blank. */}
      {!isWindows && <OpenDiscordButton label="Open Discord's sign-in page" />}
    </PanelSection>
  );
}
