import asyncio
import json
import sys
from pathlib import Path

# The decky plugin module is located at decky-loader/plugin
# For easy intellisense checkout the decky-loader code repo
# and add the `decky-loader/plugin/imports` path to `python.analysis.extraPaths` in `.vscode/settings.json`
import decky
from aiohttp import ClientSession, WSMsgType  # bundled with Decky Loader

import screenshare  # lives in py_modules/

# Steam's CEF exposes the DevTools protocol locally; Decky itself relies on it.
DEVTOOLS_URL = "http://127.0.0.1:8080/json"
# The frontend creates the hidden browser view on this URL so we can find it.
BOOT_URL = "data:text/plain,discord-deck-boot"
DISCORD_URL = "https://discord.com/app"
BINDING = "discordDeckEmit"
IS_WINDOWS = sys.platform == "win32"
# On Windows, Big Picture doesn't draw the hidden view and display scaling makes
# Discord's page too narrow to show its QR panel, so lay the page out at a fixed
# desktop size instead. The panel then shows the QR code itself.
WINDOWS_VIEWPORT = {"width": 1280, "height": 800, "deviceScaleFactor": 1, "mobile": False}


def bridge_source() -> str:
    plugin_dir = Path(decky.DECKY_PLUGIN_DIR)
    for path in (plugin_dir / "bridge.js", plugin_dir / "defaults" / "bridge.js"):
        if path.exists():
            return path.read_text()
    raise FileNotFoundError("bridge.js not found in plugin directory")


class DevToolsTab:
    """A minimal DevTools protocol client for one browser tab."""

    def __init__(self, ws_url: str, on_event, on_closed, on_page_event=None):
        self.ws_url = ws_url
        self.on_event = on_event
        self.on_closed = on_closed
        self.on_page_event = on_page_event
        self.session = None
        self.ws = None
        self.reader = None
        self.next_id = 0
        self.pending: dict[int, asyncio.Future] = {}

    async def connect(self):
        self.session = ClientSession()
        self.ws = await self.session.ws_connect(self.ws_url, max_msg_size=0)
        self.reader = asyncio.create_task(self._read())

    async def send(self, method: str, params: dict | None = None, timeout: float = 15):
        if self.ws is None or self.ws.closed:
            raise RuntimeError("Discord tab is not connected")
        self.next_id += 1
        msg_id = self.next_id
        future = asyncio.get_event_loop().create_future()
        self.pending[msg_id] = future
        await self.ws.send_json({"id": msg_id, "method": method, "params": params or {}})
        try:
            return await asyncio.wait_for(future, timeout)
        finally:
            self.pending.pop(msg_id, None)

    async def evaluate(self, expression: str, timeout: float = 15):
        try:
            res = await self.send("Runtime.evaluate", {
                "expression": expression,
                "awaitPromise": True,
                "returnByValue": True,
            }, timeout)
        except asyncio.TimeoutError:
            raise RuntimeError("Discord didn't respond in time") from None
        if "exceptionDetails" in res:
            details = res["exceptionDetails"]
            message = details.get("exception", {}).get("description") or details.get("text") or ""
            # Keep the first line only (no JS stack trace), minus the "Error: " prefix.
            message = message.split("\n")[0].removeprefix("Uncaught ").removeprefix("Error: ")
            raise RuntimeError(message)
        return res.get("result", {}).get("value")

    async def _read(self):
        try:
            async for msg in self.ws:
                if msg.type != WSMsgType.TEXT:
                    continue
                data = json.loads(msg.data)
                if "id" in data:
                    future = self.pending.get(data["id"])
                    if future and not future.done():
                        if "error" in data:
                            future.set_exception(RuntimeError(data["error"].get("message")))
                        else:
                            future.set_result(data.get("result", {}))
                elif data.get("method") in ("Page.frameNavigated", "Page.loadEventFired"):
                    if self.on_page_event is not None:
                        await self.on_page_event(data["method"], data.get("params", {}))
                elif data.get("method") == "Runtime.bindingCalled":
                    params = data.get("params", {})
                    if params.get("name") == BINDING:
                        try:
                            await self.on_event(json.loads(params.get("payload", "{}")))
                        except Exception:
                            decky.logger.exception("Failed to handle Discord tab event")
        finally:
            if self.session is not None and not self.session.closed:
                await self.session.close()
            for future in self.pending.values():
                if not future.done():
                    future.set_exception(RuntimeError("Discord tab closed"))
            await self.on_closed(self)

    async def close(self):
        if self.ws is not None and not self.ws.closed:
            await self.ws.close()
        if self.session is not None:
            await self.session.close()


async def keep_page_focused(tab: DevToolsTab):
    """The view is hidden most of the time; tell Chromium to treat it as focused
    so Discord doesn't idle. Best effort."""
    try:
        await tab.send("Emulation.setFocusEmulationEnabled", {"enabled": True})
    except Exception as e:
        decky.logger.warning(f"Emulation.setFocusEmulationEnabled failed: {e}")


async def find_tab_ws_url(url: str, attempts: int = 50) -> str:
    async with ClientSession() as session:
        for _ in range(attempts):
            try:
                async with session.get(DEVTOOLS_URL, timeout=3) as res:
                    for tab in await res.json(content_type=None):
                        if tab.get("url") == url and tab.get("webSocketDebuggerUrl"):
                            return tab["webSocketDebuggerUrl"]
            except Exception:
                pass
            await asyncio.sleep(0.2)
    raise RuntimeError("Could not find the Discord browser view")


class Plugin:
    tab: DevToolsTab | None = None
    last_state: dict = {}
    # How far the Discord page itself got: navigated to discord.com, finished loading.
    page: dict = {}
    attach_lock: asyncio.Lock | None = None
    # Screen sharing (Windows), see py_modules/screenshare.py.
    screen_share: "screenshare.ShareSession | None" = None

    # Called by the frontend once it has created the hidden browser view.
    async def attach(self) -> bool:
        async with self.attach_lock:
            if self.tab is not None:
                old, self.tab = self.tab, None
                await old.close()
            self.last_state = {}
            self.page = {}

            ws_url = await find_tab_ws_url(BOOT_URL)
            tab = DevToolsTab(ws_url, self._on_tab_event, self._on_tab_closed, self._on_page_event)
            await tab.connect()
            try:
                await tab.send("Runtime.enable")
                await tab.send("Page.enable")
                await tab.send("Runtime.addBinding", {"name": BINDING})
                await tab.send("Page.addScriptToEvaluateOnNewDocument", {
                    "source": bridge_source(),
                    "runImmediately": True,
                })
                await keep_page_focused(tab)
                if IS_WINDOWS:
                    try:
                        await tab.send("Emulation.setDeviceMetricsOverride", WINDOWS_VIEWPORT)
                    except Exception as e:
                        decky.logger.warning(f"Emulation.setDeviceMetricsOverride failed: {e}")
                self.tab = tab
                await tab.send("Page.navigate", {"url": DISCORD_URL})
            except Exception:
                self.tab = None
                await tab.close()
                raise
            decky.logger.info("Discord tab attached")
            return True

    async def get_platform(self) -> str:
        return sys.platform

    async def get_version(self) -> str:
        return decky.DECKY_PLUGIN_VERSION

    async def get_state(self) -> dict:
        # Until Discord reports ready and signed in, ask the page directly instead
        # of waiting for its own (throttled, since the view is hidden) state push.
        # While signed out this also picks up the sign-in QR code as it changes.
        if self.tab is not None and not (self.last_state.get("ready") and self.last_state.get("loggedIn")):
            try:
                snapshot = await self.tab.evaluate(
                    "window.__discordDeck ? window.__discordDeck.run('state') : null", timeout=3)
                if isinstance(snapshot, dict):
                    self.last_state = snapshot
            except Exception:
                pass
        return {
            "attached": self.tab is not None,
            "page": self.page,
            **self.last_state,
            "share": self.screen_share.status,
        }

    async def _on_page_event(self, method: str, params: dict):
        if method == "Page.frameNavigated":
            frame = params.get("frame", {})
            if frame.get("parentId"):
                return
            self.page = {"url": frame.get("url", ""), "loaded": False}
        else:
            self.page = {**self.page, "loaded": True}
        decky.logger.info(f"Discord page: {self.page}")
        await decky.emit("state", await self.get_state())

    # Runs one of the bridge's commands inside the Discord tab.
    async def command(self, name: str, args: dict | None = None):
        if self.tab is None:
            raise RuntimeError("Discord is not running")
        expression = (
            "window.__discordDeck ? window.__discordDeck.run("
            f"{json.dumps(name)}, {json.dumps(args or {})}"
            ") : Promise.reject(new Error('Discord is still loading'))"
        )
        return await self.tab.evaluate(expression)

    async def _on_tab_event(self, event: dict):
        kind = event.get("type")
        if kind == "state":
            self.last_state = event.get("state") or {}
            await self.screen_share.check_stream(self.last_state)
            await decky.emit("state", await self.get_state())
        elif kind == "micOffer":
            await decky.emit("mic_offer", event.get("sdp"))
        elif kind == "keyboard":
            await decky.emit("show_keyboard")

    async def _on_tab_closed(self, tab: DevToolsTab):
        if self.tab is not tab:
            return
        await self.screen_share.reset()
        decky.logger.warning("Discord tab connection closed")
        self.tab = None
        self.last_state = {}
        self.page = {}
        await decky.emit("tab_lost")

    # --- Screen sharing (Windows) ---------------------------------------------

    async def share_sources(self) -> list:
        return screenshare.list_sources()

    async def share_start(self, source_id: str, quality: str = "720p30") -> bool:
        await self.screen_share.start(source_id, quality)
        return True

    async def share_stop(self) -> bool:
        await self.screen_share.stop()
        return True

    async def _push_state(self):
        await decky.emit("state", await self.get_state())

    async def _main(self):
        self.attach_lock = asyncio.Lock()
        self.screen_share = screenshare.ShareSession(
            decky.DECKY_PLUGIN_RUNTIME_DIR, decky.logger,
            command=self.command, on_change=self._push_state,
        )
        decky.logger.info("Discord Deck backend started")

    async def _unload(self):
        await self.screen_share.reset()
        if self.tab is not None:
            tab, self.tab = self.tab, None
            await tab.close()
        decky.logger.info("Discord Deck backend stopped")

    async def _uninstall(self):
        pass
