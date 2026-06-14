"""clip step — cut a segment, optionally crop to 9:16 (static or face-tracked).

With ``track_face`` the speaker is detected per-sampled-frame, the crop window is
smoothed, and a 1080x1920 vertical clip is rendered; otherwise a static crop (for
``crop_format: tiktok``) or a plain cut is produced.
"""

import subprocess
import sys
import tempfile
import urllib.request
from pathlib import Path

from .base import Output, Param, Step, StepContext

_MODEL_DIR = Path.home() / ".cache" / "video-radiant"
_PROTO_NAME = "deploy.prototxt"
_WEIGHTS_NAME = "res10_300x300_ssd_iter_140000.caffemodel"
_PROTO_URL = (
    "https://raw.githubusercontent.com/opencv/opencv/master"
    "/samples/dnn/face_detector/deploy.prototxt"
)
_WEIGHTS_URL = (
    "https://github.com/opencv/opencv_3rdparty/raw"
    "/dnn_samples_face_detector_20170830"
    "/res10_300x300_ssd_iter_140000.caffemodel"
)


def _ensure_model() -> tuple[Path, Path]:
    _MODEL_DIR.mkdir(parents=True, exist_ok=True)
    proto = _MODEL_DIR / _PROTO_NAME
    weights = _MODEL_DIR / _WEIGHTS_NAME
    if not proto.exists():
        print(f"Downloading face detector proto → {proto}")
        urllib.request.urlretrieve(_PROTO_URL, proto)
    if not weights.exists():
        print(f"Downloading face detector weights → {weights} (~10 MB)")
        urllib.request.urlretrieve(_WEIGHTS_URL, weights)
    return proto, weights


def _detect_centers(video_path, frame_w, frame_h, sample=10, conf_threshold=0.5):
    import cv2

    proto, weights = _ensure_model()
    net = cv2.dnn.readNetFromCaffe(str(proto), str(weights))

    cap = cv2.VideoCapture(video_path)
    total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))

    sampled_indices, sampled_xs, sampled_ys = [], [], []
    last_cx, last_cy = frame_w / 2.0, frame_h / 2.0

    frame_idx = 0
    while True:
        ret, frame = cap.read()
        if not ret:
            break
        if frame_idx % sample == 0:
            blob = cv2.dnn.blobFromImage(
                cv2.resize(frame, (300, 300)), 1.0, (300, 300), (104.0, 177.0, 123.0)
            )
            net.setInput(blob)
            detections = net.forward()
            best_conf, best_cx, best_cy = 0.0, last_cx, last_cy
            for i in range(detections.shape[2]):
                conf = float(detections[0, 0, i, 2])
                if conf > conf_threshold and conf > best_conf:
                    best_conf = conf
                    x1 = detections[0, 0, i, 3] * frame_w
                    y1 = detections[0, 0, i, 4] * frame_h
                    x2 = detections[0, 0, i, 5] * frame_w
                    y2 = detections[0, 0, i, 6] * frame_h
                    best_cx = (x1 + x2) / 2.0
                    best_cy = (y1 + y2) / 2.0
            last_cx, last_cy = best_cx, best_cy
            sampled_indices.append(frame_idx)
            sampled_xs.append(last_cx)
            sampled_ys.append(last_cy)
        frame_idx += 1

    cap.release()
    n_frames = frame_idx if frame_idx > 0 else total

    import numpy as np

    all_indices = np.arange(n_frames)
    xs = np.interp(all_indices, sampled_indices, sampled_xs)
    ys = np.interp(all_indices, sampled_indices, sampled_ys)
    return list(zip(xs.tolist(), ys.tolist()))


def _smooth_and_clamp(centers, frame_w, frame_h, sigma=30.0):
    import numpy as np
    from scipy.ndimage import gaussian_filter1d

    xs = np.array([c[0] for c in centers])
    ys = np.array([c[1] for c in centers])
    xs = gaussian_filter1d(xs, sigma)
    ys = gaussian_filter1d(ys, sigma)
    crop_w = frame_h * 9.0 / 16.0
    xs = np.clip(xs, crop_w / 2.0, frame_w - crop_w / 2.0)
    ys = np.clip(ys, 0.0, frame_h)
    return list(zip(xs.tolist(), ys.tolist()))


def _track_and_encode(input_path, start, end, output_path, sample=10, sigma=30.0, preview=None):
    import cv2

    with tempfile.TemporaryDirectory() as tmp:
        tmp_clip = str(Path(tmp) / "clip.mp4")
        tmp_video = str(Path(tmp) / "video_only.mp4")

        span = ["-t", str(preview)] if preview is not None else ["-to", end]
        run_cmd = ["ffmpeg", "-y", "-ss", start, *span, "-i", str(input_path), "-c", "copy", tmp_clip]
        print("Extracting clip:", " ".join(run_cmd))
        if subprocess.run(run_cmd).returncode != 0:
            sys.exit("ffmpeg extraction failed")

        cap = cv2.VideoCapture(tmp_clip)
        frame_w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
        frame_h = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
        fps = cap.get(cv2.CAP_PROP_FPS) or 25.0
        cap.release()

        print(f"Detecting faces (every {sample} frames)…")
        raw = _detect_centers(tmp_clip, frame_w, frame_h, sample=sample)
        centers = _smooth_and_clamp(raw, frame_w, frame_h, sigma=sigma)

        crop_w = int(frame_h * 9 / 16)
        fourcc = cv2.VideoWriter_fourcc(*"mp4v")
        writer = cv2.VideoWriter(tmp_video, fourcc, fps, (1080, 1920))

        cap2 = cv2.VideoCapture(tmp_clip)
        total = len(centers)
        for i, (cx, _cy) in enumerate(centers):
            ret, frame = cap2.read()
            if not ret:
                break
            x0 = max(0, int(cx - crop_w / 2))
            x0 = min(x0, frame_w - crop_w)
            cropped = frame[0:frame_h, x0:x0 + crop_w]
            writer.write(cv2.resize(cropped, (1080, 1920)))
            if (i + 1) % 100 == 0:
                print(f"  encoded {i + 1}/{total} frames")
        cap2.release()
        writer.release()

        mux_cmd = [
            "ffmpeg", "-y", "-i", tmp_video, "-i", tmp_clip,
            "-map", "0:v", "-map", "1:a?",
            "-c:v", "libx264", "-crf", "18", "-preset", "fast",
            "-c:a", "aac", str(output_path),
        ]
        print("Muxing audio:", " ".join(mux_cmd))
        if subprocess.run(mux_cmd).returncode != 0:
            sys.exit("ffmpeg mux failed")


def _build_filter(fmt: str) -> str | None:
    if fmt == "tiktok":
        return "crop=ih*9/16:ih:(iw-ih*9/16)/2:0,scale=1080:1920"
    return None


class ClipStep(Step):
    action = "clip"
    summary = "Cut a segment, optionally crop to 9:16 (static or face-tracked)."
    params = (
        Param("input", "Source video to clip from.", type="path", required=True),
        Param("start", "Clip start time (seconds or HH:MM:SS).", required=True),
        Param("end", "Clip end time (ignored under --preview, which caps to N seconds).",
              required=True),
        Param("output", "Output filename written under the step dir.", required=True),
        Param("track_face", "Detect and follow the speaker's face for a 9:16 crop.",
              type="bool", default=False),
        Param("crop_format", "Static crop preset when not face-tracking.",
              type="enum", choices=("default", "tiktok"), default="default"),
        Param("track_sample", "Face-track: detect every Nth frame (interpolate between).",
              type="int", default=10),
        Param("track_sigma", "Face-track: Gaussian smoothing width for the crop path.",
              type="float", default=30.0),
    )
    outputs = (
        Output("file", "Absolute path to the clipped mp4.", artifact=True),
    )

    def run(self, params: dict, ctx: StepContext) -> dict:
        input_path = Path(self.require(params, "input"))
        start = str(self.require(params, "start"))
        end = str(self.require(params, "end"))
        output_name = self.require(params, "output")
        out = ctx.out_path(output_name)

        track_face = self.as_bool(params.get("track_face"))
        crop_fmt = params.get("crop_format", "default")
        sample = int(params.get("track_sample", 10))
        sigma = float(params.get("track_sigma", 30.0))

        if not ctx.dry_run and not input_path.exists():
            sys.exit(f"Error: input file not found: {input_path}")

        span_label = f"{start} +{ctx.preview}s (preview)" if ctx.preview is not None else f"{start}–{end}"

        if track_face:
            print(f"  Face-tracked 9:16 clip {span_label} (sample={sample}, sigma={sigma})")
            if ctx.dry_run:
                print(f"  [dry-run] would face-track and encode → {out}")
                return {"file": str(out.resolve())}
            _track_and_encode(input_path, start, end, out, sample=sample, sigma=sigma, preview=ctx.preview)
            return {"file": str(out.resolve())}

        print(f"  Clip {span_label} crop={crop_fmt} → {out}")
        vf = _build_filter(crop_fmt)
        span = ["-t", str(ctx.preview)] if ctx.preview is not None else ["-to", end]
        cmd = ["ffmpeg", "-y", "-ss", start, *span, "-i", str(input_path)]
        if vf:
            cmd += ["-vf", vf]
        cmd += ["-c:v", "libx264", "-crf", "18", "-preset", "fast", "-c:a", "aac", str(out)]
        ctx.run(cmd)
        return {"file": str(out.resolve())}
