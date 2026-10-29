import { ButtonItem, Navigation, PanelSectionRow } from "@decky/ui";
import { toaster } from "@decky/api";
import { command } from "../backend";
import { DISCORD_ROUTE } from "./DiscordPage";

export const showError = (e: unknown) => toaster.toast({ title: "Discord", body: String(e) });

// Runs a bridge command; on failure shows the error and returns undefined.
export const run = async (name: string, args: Record<string, unknown> = {}) => {
  try {
    return await command(name, args);
  } catch (e) {
    showError(e);
    return undefined;
  }
};

const openDiscord = () => {
  Navigation.Navigate(DISCORD_ROUTE);
  Navigation.CloseSideMenus();
};

export function OpenDiscordButton({ label = "Open Discord" }: { label?: string }) {
  return (
    <PanelSectionRow>
      <ButtonItem layout="below" onClick={openDiscord}>
        {label}
      </ButtonItem>
    </PanelSectionRow>
  );
}

// A bold heading with a line of explanation under it.
export function StatusLine({ step, text }: { step: string; text: string }) {
  return (
    <PanelSectionRow>
      <div>
        <div style={{ fontWeight: "bold" }}>{step}</div>
        <div style={{ opacity: 0.8 }}>{text}</div>
      </div>
    </PanelSectionRow>
  );
}
