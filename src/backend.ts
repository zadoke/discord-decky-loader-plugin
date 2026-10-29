import { addEventListener, call, callable, removeEventListener } from "@decky/api";
import { useEffect, useState } from "react";

export interface VoiceMember {
  id: string;
  name: string;
  muted: boolean;
  deafened: boolean;
}

export interface DiscordState {
  attached: boolean;
  // How far the Discord page got: navigated to discord.com, finished loading.
  page?: { url?: string; loaded?: boolean };
  ready?: boolean;
  loggedIn?: boolean;
  user?: { id: string; name: string; avatar: string | null };
  muted?: boolean;
  deafened?: boolean;
  voice?: {
    channelId: string;
    channelName: string;
    guildName: string | null;
    members: VoiceMember[];
  } | null;
  rtc?: string | null;
  joinError?: string | null;
  mic?: { status: "idle" | "requesting" | "ok" | "failed"; error?: string };
  screen?: { width: number; height: number };
  // While signed out: the login page's QR link, and whether it was just scanned.
  qr?: { url: string | null; scanned: boolean } | null;
  // Go Live is on.
  streaming?: boolean;
  // Screen share started from the panel (Windows), tracked by the backend.
  share?: ShareStatus;
}

export interface ShareStatus {
  status: "idle" | "downloading" | "starting" | "live" | "error";
  progress?: number;
  encoder?: string;
  quality?: string;
  error?: string;
}

export interface ShareSource {
  id: string;
  kind: "monitor" | "window";
  label: string;
  detail: string;
}

export interface Guild {
  id: string;
  name: string;
}

export interface VoiceChannel {
  id: string;
  name: string;
  memberCount: number;
}

export const attach = callable<[], boolean>("attach");
export const getState = callable<[], DiscordState>("get_state");
// Python's sys.platform on the machine running Decky, e.g. "linux" or "win32".
export const getPlatform = callable<[], string>("get_platform");
export const shareSources = callable<[], ShareSource[]>("share_sources");
export const shareStart = callable<[string, string], boolean>("share_start");
export const shareStop = callable<[], boolean>("share_stop");

// Runs a command inside the Discord tab (see defaults/bridge.js).
export const command = <T = null>(name: string, args: Record<string, unknown> = {}) =>
  call<[string, Record<string, unknown>], T>("command", name, args);

export function useDiscordState() {
  const [state, setState] = useState<DiscordState>({ attached: false });
  // Also poll while signed out, so the sign-in QR code stays current.
  const waiting = !state.attached || !state.ready || !state.loggedIn;

  // Pushed "state" events can be missed while the panel is open, so poll
  // until Discord is ready; reopening the panel did the same by hand.
  useEffect(() => {
    if (!waiting) return;
    const timer = setInterval(() => getState().then(setState).catch(() => {}), 2000);
    return () => clearInterval(timer);
  }, [waiting]);

  useEffect(() => {
    getState().then(setState).catch(() => {});
    const onState = (s: DiscordState) => setState(s);
    const onLost = () => setState({ attached: false });
    addEventListener<[DiscordState]>("state", onState);
    addEventListener("tab_lost", onLost);
    return () => {
      removeEventListener("state", onState);
      removeEventListener("tab_lost", onLost);
    };
  }, []);

  return state;
}
