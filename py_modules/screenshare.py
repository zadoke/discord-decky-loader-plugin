"""Screen sharing on Windows.

Steam's UI isn't allowed to capture the screen, so we capture it outside the
browser: ffmpeg grabs a window or monitor with Windows Graphics Capture
(gfxcapture), encodes it to H.264 on the GPU when it can (NVENC, AMF, Quick
Sync, else x264), and we send each encoded frame to the Discord page over a
local websocket. There bridge.js decodes it with WebCodecs and hands Discord a
normal video track when it asks to share the screen.
"""

import asyncio
import ctypes
import os
import secrets
import shutil
import struct
import sys
import time
import zipfile
from pathlib import Path

from aiohttp import web

IS_WINDOWS = sys.platform == "win32"

# BtbN's static Windows builds; 8.1 is the first release with gfxcapture.
FFMPEG_URL = (
    "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/"
    "ffmpeg-n8.1-latest-win64-gpl-8.1.zip"
)
CREATE_NO_WINDOW = 0x08000000

# Tried in order; the first one that can encode a test clip wins.
ENCODERS = ["h264_nvenc", "h264_amf", "h264_qsv", "libx264"]
ENCODER_NAMES = {
    "h264_nvenc": "NVIDIA NVENC",
    "h264_amf": "AMD AMF",
    "h264_qsv": "Intel Quick Sync",
    "libx264": "CPU (x264)",
}

# loopback only and discord re-encodes it, so high bitrate
QUALITIES = {
    "720p30": {"height": 720, "fps": 30, "bitrate": "12000k"},
    "1080p30": {"height": 1080, "fps": 30, "bitrate": "20000k"},
    "1080p60": {"height": 1080, "fps": 60, "bitrate": "30000k"},
}


def _popen_kwargs():
    return {"creationflags": CREATE_NO_WINDOW} if IS_WINDOWS else {}


# --- Picking what to capture --------------------------------------------------


def list_sources() -> list[dict]:
    """Monitors first, then visible top-level windows with a title."""
    if not IS_WINDOWS:
        raise RuntimeError("Screen sharing is only available on Windows for now")
    from ctypes import wintypes as wt

    user32 = ctypes.windll.user32
    dwmapi = ctypes.windll.dwmapi
    kernel32 = ctypes.windll.kernel32
    sources: list[dict] = []

    class RECT(ctypes.Structure):
        _fields_ = [("left", ctypes.c_long), ("top", ctypes.c_long),
                    ("right", ctypes.c_long), ("bottom", ctypes.c_long)]

    class MONITORINFO(ctypes.Structure):
        _fields_ = [("cbSize", wt.DWORD), ("rcMonitor", RECT),
                    ("rcWork", RECT), ("dwFlags", wt.DWORD)]

    monitor_proc = ctypes.WINFUNCTYPE(wt.BOOL, wt.HMONITOR, wt.HDC, ctypes.POINTER(RECT), wt.LPARAM)

    def on_monitor(hmon, _hdc, _rect, _lparam):
        info = MONITORINFO()
        info.cbSize = ctypes.sizeof(MONITORINFO)
        user32.GetMonitorInfoW(hmon, ctypes.byref(info))
        r = info.rcMonitor
        n = sum(1 for s in sources if s["kind"] == "monitor") + 1
        primary = " · main" if info.dwFlags & 1 else ""
        sources.append({
            "id": f"monitor:{int(hmon)}",
            "kind": "monitor",
            "label": f"Screen {n}{primary}",
            "detail": f"{r.right - r.left}×{r.bottom - r.top}",
        })
        return True

    user32.EnumDisplayMonitors(None, None, monitor_proc(on_monitor), 0)

    def exe_name(hwnd) -> str:
        pid = wt.DWORD()
        user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
        handle = kernel32.OpenProcess(0x1000, False, pid.value)  # QUERY_LIMITED_INFORMATION
        if not handle:
            return ""
        try:
            size = wt.DWORD(1024)
            buf = ctypes.create_unicode_buffer(size.value)
            if kernel32.QueryFullProcessImageNameW(handle, 0, buf, ctypes.byref(size)):
                return os.path.basename(buf.value)
            return ""
        finally:
            kernel32.CloseHandle(handle)

    own_pid = os.getpid()
    window_proc = ctypes.WINFUNCTYPE(wt.BOOL, wt.HWND, wt.LPARAM)

    def on_window(hwnd, _lparam):
        if not user32.IsWindowVisible(hwnd) or user32.GetWindow(hwnd, 4):  # GW_OWNER
            return True
        if user32.GetWindowLongW(hwnd, -20) & 0x80:  # WS_EX_TOOLWINDOW
            return True
        cloaked = wt.DWORD()
        dwmapi.DwmGetWindowAttribute(hwnd, 14, ctypes.byref(cloaked), ctypes.sizeof(cloaked))
        if cloaked.value:
            return True
        length = user32.GetWindowTextLengthW(hwnd)
        if not length:
            return True
        pid = wt.DWORD()
        user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
        if pid.value == own_pid:
            return True
        title = ctypes.create_unicode_buffer(length + 1)
        user32.GetWindowTextW(hwnd, title, length + 1)
        sources.append({
            "id": f"window:{int(hwnd)}",
            "kind": "window",
            "label": title.value,
            "detail": exe_name(hwnd),
        })
        return True

    user32.EnumWindows(window_proc(on_window), 0)
    return sources


# --- ffmpeg -------------------------------------------------------------------


class Ffmpeg:
    def __init__(self, runtime_dir: str, logger):
        self.dir = Path(runtime_dir) / "ffmpeg"
        self.logger = logger
        self.encoder: str | None = None
        self._lock = asyncio.Lock()

    @property
    def exe(self) -> Path:
        return self.dir / ("ffmpeg.exe" if IS_WINDOWS else "ffmpeg")

    def available(self) -> bool:
        if self.exe.exists():
            return True
        # Handy for development off Windows: use a system ffmpeg if there is one.
        return not IS_WINDOWS and shutil.which("ffmpeg") is not None

    def path(self) -> str:
        return str(self.exe) if self.exe.exists() else (shutil.which("ffmpeg") or str(self.exe))

    async def ensure(self, on_progress) -> None:
        """Downloads ffmpeg on first use (about 190 MB) and picks an encoder."""
        async with self._lock:
            if not self.available():
                await self._download(on_progress)
            if self.encoder is None:
                self.encoder = await self._pick_encoder()
                self.logger.info(f"[share] using encoder {self.encoder}")

    async def _download(self, on_progress) -> None:
        from aiohttp import ClientSession, ClientTimeout

        self.dir.mkdir(parents=True, exist_ok=True)
        archive = self.dir / "download.zip"
        self.logger.info(f"[share] downloading {FFMPEG_URL}")
        async with ClientSession(timeout=ClientTimeout(total=None, sock_read=60)) as session:
            async with session.get(FFMPEG_URL) as res:
                res.raise_for_status()
                total = int(res.headers.get("Content-Length") or 0)
                done = 0
                last = 0.0
                with open(archive, "wb") as f:
                    async for chunk in res.content.iter_chunked(1 << 20):
                        f.write(chunk)
                        done += len(chunk)
                        if total and time.monotonic() - last > 0.5:
                            last = time.monotonic()
                            await on_progress(done / total)

        def extract():
            with zipfile.ZipFile(archive) as z:
                member = next(n for n in z.namelist() if n.endswith("/bin/ffmpeg.exe"))
                with z.open(member) as src, open(self.exe, "wb") as dst:
                    shutil.copyfileobj(src, dst)

        try:
            await asyncio.get_running_loop().run_in_executor(None, extract)
        finally:
            archive.unlink(missing_ok=True)

    async def _pick_encoder(self) -> str:
        for encoder in ENCODERS:
            fmt = "yuv420p" if encoder == "libx264" else "nv12"
            proc = await asyncio.create_subprocess_exec(
                self.path(), "-hide_banner", "-loglevel", "error",
                "-f", "lavfi", "-i", "color=c=black:s=640x360:r=30",
                "-frames:v", "5", "-pix_fmt", fmt, "-c:v", encoder, "-f", "null", "-",
                stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.PIPE,
                **_popen_kwargs(),
            )
            try:
                _, err = await asyncio.wait_for(proc.communicate(), 20)
            except asyncio.TimeoutError:
                proc.kill()
                continue
            if proc.returncode == 0:
                return encoder
            self.logger.info(f"[share] {encoder} unavailable: {err.decode(errors='replace').strip()[-200:]}")
        raise RuntimeError("ffmpeg couldn't find a working H.264 encoder")


def build_command(ffmpeg: str, source_id: str, encoder: str, quality: str) -> list[str]:
    q = QUALITIES.get(quality, QUALITIES["720p30"])
    kind, _, handle = source_id.partition(":")
    if kind == "monitor":
        capture = f"gfxcapture=hmonitor={int(handle)}"
    elif kind == "window":
        capture = f"gfxcapture=hwnd={int(handle)}"
    elif kind == "test":  # development only: a moving test pattern
        capture = f"testsrc2=s=1280x720:r={q['fps']},realtime,format=bgra"
    else:
        raise ValueError(f"Unknown source: {source_id}")
    if kind != "test":
        capture += f":max_framerate={q['fps']}:capture_cursor=1,hwdownload,format=bgra"

    pix = "yuv420p" if encoder == "libx264" else "nv12"
    # Downscale only, keep the aspect ratio, and keep both sides even.
    graph = (
        f"{capture},scale=w=-2:h='trunc(min(ih,{q['height']})/2)*2':flags=bilinear,"
        f"fps={q['fps']},format={pix}"
    )
    gop = str(q["fps"] * 2)  # a keyframe every 2 s lets the decoder recover quickly
    rate = ["-b:v", q["bitrate"], "-maxrate", q["bitrate"], "-bufsize", q["bitrate"]]
    args = {
        "h264_nvenc": ["-preset", "p4", "-tune", "ll", "-rc", "cbr", "-profile:v", "high"],
        "h264_amf": ["-usage", "lowlatency", "-rc", "cbr", "-profile:v", "high"],
        "h264_qsv": ["-preset", "veryfast", "-profile:v", "high"],
        "libx264": ["-preset", "veryfast", "-tune", "zerolatency", "-profile:v", "high"],
    }[encoder]
    return [
        ffmpeg, "-hide_banner", "-loglevel", "warning", "-nostdin",
        "-filter_complex", graph, "-an",
        "-c:v", encoder, *args, *rate, "-g", gop, "-bf", "0",
        "-f", "h264", "-flush_packets", "1", "-",
    ]


# --- Splitting the H.264 stream into frames ------------------------------------


class AnnexBSplitter:
    """Turns a raw Annex B H.264 byte stream into access units (one per frame)."""

    def __init__(self):
        self.buf = bytearray()
        self.au: list[bytes] = []
        self.au_has_slice = False
        self.au_key = False
        self.codec: str | None = None  # e.g. avc1.640028, from the first SPS

    def feed(self, data: bytes) -> list[tuple[bytes, bool]]:
        self.buf += data
        out: list[tuple[bytes, bool]] = []
        starts = self._start_codes()
        # Every NAL but the last is complete; the last may still be arriving.
        for (s, hdr), (nxt, _) in zip(starts, starts[1:]):
            nal = bytes(self.buf[hdr:nxt]).rstrip(b"\x00")
            if nal:
                self._nal(nal, out)
        if starts:
            del self.buf[:starts[-1][0]]
        return out

    def _start_codes(self) -> list[tuple[int, int]]:
        """(start of start code, start of NAL header) for each start code."""
        found = []
        i = 0
        buf = self.buf
        while True:
            i = buf.find(b"\x00\x00\x01", i)
            if i < 0:
                return found
            start = i - 1 if i > 0 and buf[i - 1] == 0 else i
            found.append((start, i + 3))
            i += 3

    def _nal(self, nal: bytes, out) -> None:
        nal_type = nal[0] & 0x1F
        is_slice = nal_type in (1, 5)
        if nal_type == 7 and self.codec is None and len(nal) >= 4:
            self.codec = "avc1.%02x%02x%02x" % (nal[1], nal[2], nal[3])
        # A new frame starts at an AUD/SPS/PPS/SEI after a slice, or at a slice
        # whose first_mb_in_slice is 0 (its first bit is 1 in exp-Golomb).
        starts_frame = (
            (nal_type in (6, 7, 8, 9) and self.au_has_slice)
            or (is_slice and self.au_has_slice and len(nal) > 1 and nal[1] & 0x80)
        )
        if starts_frame:
            self.flush(out)
        self.au.append(b"\x00\x00\x00\x01" + nal)
        if is_slice:
            self.au_has_slice = True
        if nal_type == 5:
            self.au_key = True

    def flush(self, out) -> None:
        if self.au and self.au_has_slice:
            out.append((b"".join(self.au), self.au_key))
        self.au = []
        self.au_has_slice = False
        self.au_key = False


# --- A running share ----------------------------------------------------------


class FrameRelay:
    """Websocket the page pulls frames from. discord's CSP allows 127.0.0.1.

    binary: key flag (1 byte) + timestamp (f64 LE, us) + frame
    text: codec, whenever it changes
    """

    def __init__(self):
        self._token = secrets.token_urlsafe(16)
        self._runner: web.AppRunner | None = None
        self._ws: web.WebSocketResponse | None = None
        self._connected = asyncio.Event()
        self._codec: str | None = None

    async def start(self) -> str:
        """Returns the url for the page."""
        app = web.Application()
        app.router.add_get("/", self._handle)
        self._runner = web.AppRunner(app, access_log=None)
        await self._runner.setup()
        await web.TCPSite(self._runner, "127.0.0.1", 0).start()
        port = self._runner.addresses[0][1]
        return f"ws://127.0.0.1:{port}/?token={self._token}"

    async def wait_connected(self, timeout: float) -> None:
        try:
            await asyncio.wait_for(self._connected.wait(), timeout)
        except asyncio.TimeoutError:
            raise RuntimeError("The Discord page couldn't connect to the capture") from None

    async def _handle(self, request: web.Request):
        # token so other local pages can't connect
        if request.query.get("token") != self._token or self._ws is not None:
            return web.Response(status=403)
        # h264 doesn't compress, don't waste cpu on deflate
        ws = web.WebSocketResponse(compress=False)
        await ws.prepare(request)
        self._ws = ws
        self._connected.set()
        async for _ in ws:  # page never sends anything
            pass
        return ws

    async def send(self, au: bytes, key: bool, ts: int, codec: str) -> None:
        ws = self._ws
        if ws is None or ws.closed:
            return  # page is gone, tab-closed cleans up
        if codec != self._codec:
            self._codec = codec
            await ws.send_str(codec)
        await ws.send_bytes(struct.pack("<Bd", 1 if key else 0, ts) + au)

    async def stop(self) -> None:
        if self._ws is not None:
            await self._ws.close()
        if self._runner is not None:
            await self._runner.cleanup()


class Capture:
    """Runs ffmpeg, frames go to send_frame."""

    def __init__(self, cmd: list[str], send_frame, on_exit, logger):
        self.cmd = cmd
        self.send_frame = send_frame
        self.on_exit = on_exit
        self.logger = logger
        self.proc: asyncio.subprocess.Process | None = None
        self.frames = 0
        self.stderr_tail: list[str] = []
        self.started = time.monotonic()
        self._tasks: list[asyncio.Task] = []
        self._stopping = False

    async def start(self):
        self.logger.info("[share] " + " ".join(self.cmd))
        self.proc = await asyncio.create_subprocess_exec(
            *self.cmd,
            stdin=asyncio.subprocess.DEVNULL,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            **_popen_kwargs(),
        )
        self._tasks = [
            asyncio.create_task(self._read_frames()),
            asyncio.create_task(self._read_errors()),
        ]

    async def _read_frames(self):
        splitter = AnnexBSplitter()
        try:
            while True:
                data = await self.proc.stdout.read(1 << 16)
                if not data:
                    break
                for au, key in splitter.feed(data):
                    if not splitter.codec:
                        continue
                    ts = int((time.monotonic() - self.started) * 1_000_000)
                    self.frames += 1
                    await self.send_frame(au, key, ts, splitter.codec)
        except Exception:
            self.logger.exception("[share] frame relay failed")
        finally:
            code = await self.proc.wait()
            if not self._stopping:
                tail = " ".join(self.stderr_tail[-3:]) or f"ffmpeg exited with code {code}"
                self.logger.warning(f"[share] ffmpeg stopped: {tail}")
                await self.on_exit(tail)

    async def _read_errors(self):
        async for line in self.proc.stderr:
            text = line.decode(errors="replace").strip()
            if text:
                self.logger.info(f"[ffmpeg] {text}")
                self.stderr_tail = (self.stderr_tail + [text])[-10:]

    async def stop(self):
        self._stopping = True
        if self.proc and self.proc.returncode is None:
            self.proc.kill()
            try:
                await asyncio.wait_for(self.proc.wait(), 5)
            except asyncio.TimeoutError:
                pass
        for t in self._tasks:
            t.cancel()


# --- Session ------------------------------------------------------------------


class ShareSession:
    """Screen share started from the panel.

    command: runs a bridge.js command
    on_change: status changed, update the panel
    """

    # Discord can say "not streaming" for a moment right after going live.
    LIVE_GRACE_SECONDS = 5

    def __init__(self, runtime_dir: str, logger, command, on_change):
        self.ffmpeg = Ffmpeg(runtime_dir, logger)
        self.logger = logger
        self._command = command
        self._on_change = on_change
        self.status: dict = {"status": "idle"}  # idle, downloading, starting, live, error
        self._relay: FrameRelay | None = None
        self._capture: Capture | None = None
        self._task: asyncio.Task | None = None
        self._live_since = 0.0

    async def start(self, source_id: str, quality: str) -> None:
        if not IS_WINDOWS and not source_id.startswith("test:"):
            raise RuntimeError("Screen sharing is only available on Windows for now")
        # Ask the page directly: its own state pushes are throttled while hidden.
        state = await self._command("state") or {}
        if not (state.get("voice") or {}).get("channelId"):
            raise RuntimeError("Join a voice channel first")
        if self._task and not self._task.done():
            raise RuntimeError("Screen sharing is already starting")
        await self._stop_capture()
        self._task = asyncio.create_task(self._run(source_id, quality))

    async def stop(self) -> None:
        if self._task and not self._task.done():
            self._task.cancel()
        await self._end({"status": "idle"})

    async def check_stream(self, discord_state: dict) -> None:
        """Stop if Discord ended the stream on its own, e.g. we left the call."""
        if self.status.get("status") != "live" or discord_state.get("streaming", True):
            return
        if asyncio.get_running_loop().time() - self._live_since < self.LIVE_GRACE_SECONDS:
            return
        self.logger.info("[share] Discord stopped streaming, stopping capture")
        await self._stop_all()
        self.status = {"status": "idle"}  # no _set(), main.py sends the state right after

    async def reset(self) -> None:
        """Like stop(), but for when the tab is gone and there's no Discord to tell."""
        await self._stop_capture()
        self.status = {"status": "idle"}

    async def _set(self, status: dict) -> None:
        self.status = status
        await self._on_change()

    async def _run(self, source_id: str, quality: str) -> None:
        try:
            if not self.ffmpeg.available():
                await self._set({"status": "downloading", "progress": 0})

            async def progress(fraction: float):
                await self._set({"status": "downloading", "progress": round(fraction, 2)})

            await self.ffmpeg.ensure(progress)
            encoder = self.ffmpeg.encoder
            base = {"encoder": ENCODER_NAMES.get(encoder, encoder), "quality": quality}
            await self._set({"status": "starting", **base})

            q = QUALITIES.get(quality, QUALITIES["720p30"])
            self._relay = FrameRelay()
            url = await self._relay.start()
            await self._command("prepareShare", {
                "width": q["height"] * 16 // 9, "height": q["height"], "url": url,
            })
            await self._relay.wait_connected(5)
            cmd = build_command(self.ffmpeg.path(), source_id, encoder, quality)
            self._capture = Capture(cmd, self._relay.send, self._on_capture_exit, self.logger)
            await self._capture.start()

            # Wait until frames are being decoded on the page before going live.
            for _ in range(40):
                await asyncio.sleep(0.25)
                info = await self._command("shareInfo") or {}
                if info.get("decoded", 0) > 0:
                    break
                if info.get("error"):
                    raise RuntimeError(f"Couldn't decode the video: {info['error']}")
                if self._capture is None:
                    return  # ffmpeg died; _on_capture_exit already reported it
            else:
                raise RuntimeError("No video arrived from the capture")

            # Start the stream, then keep confirming Discord's dialog until it says we're live.
            how = await self._command("goLive")
            self.logger.info(f"[share] go live via {how}")
            for _ in range(20):
                await asyncio.sleep(0.5)
                result = await self._command("goLiveConfirm") or {}
                if result.get("streaming"):
                    self._live_since = asyncio.get_running_loop().time()
                    await self._set({"status": "live", **base})
                    return
            raise RuntimeError(f"The capture works, but Discord didn't start the stream ({how})")
        except asyncio.CancelledError:
            raise
        except Exception as e:
            self.logger.exception("[share] failed to start")
            await self._end({"status": "error", "error": str(e)})

    async def _on_capture_exit(self, error: str) -> None:
        self._capture = None  # already exited
        await self._end({"status": "error", "error": f"Capture stopped: {error}"})

    async def _end(self, status: dict) -> None:
        await self._stop_all()
        await self._set(status)

    async def _stop_all(self) -> None:
        await self._stop_capture()
        try:
            await self._command("stopShare")
        except Exception as e:
            self.logger.warning(f"[share] stopShare failed: {e}")

    async def _stop_capture(self) -> None:
        capture, self._capture = self._capture, None
        if capture is not None:
            await capture.stop()
        relay, self._relay = self._relay, None
        if relay is not None:
            await relay.stop()
