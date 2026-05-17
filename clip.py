#!/usr/bin/env python3
"""
Clip a segment from a video file, optionally cropping to TikTok (9:16) format.

Usage:
    uv run clip.py <input> --start HH:MM:SS --end HH:MM:SS [--crop-format default|tiktok] [--track-face] [--output <path>]
"""

import argparse
import subprocess
import sys
import tempfile
import urllib.request
from pathlib import Path

import numpy as np
from scipy.ndimage import gaussian_filter1d

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


def _detect_centers(
    video_path: str,
    frame_w: int,
    frame_h: int,
    sample: int = 10,
    conf_threshold: float = 0.5,
) -> list[tuple[float, float]]:
    import cv2

    proto, weights = _ensure_model()
    net = cv2.dnn.readNetFromCaffe(str(proto), str(weights))

    cap = cv2.VideoCapture(video_path)
    total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))

    # Collect (frame_index, cx, cy) for sampled frames only
    sampled_indices: list[int] = []
    sampled_xs: list[float] = []
    sampled_ys: list[float] = []
    last_cx = frame_w / 2.0
    last_cy = frame_h / 2.0

    frame_idx = 0
    while True:
        ret, frame = cap.read()
        if not ret:
            break
        if frame_idx % sample == 0:
            blob = cv2.dnn.blobFromImage(
                cv2.resize(frame, (300, 300)),
                1.0,
                (300, 300),
                (104.0, 177.0, 123.0),
            )
            net.setInput(blob)
            detections = net.forward()
            best_conf = 0.0
            best_cx, best_cy = last_cx, last_cy
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

    all_indices = np.arange(n_frames)
    xs = np.interp(all_indices, sampled_indices, sampled_xs)
    ys = np.interp(all_indices, sampled_indices, sampled_ys)
    return list(zip(xs.tolist(), ys.tolist()))


def _smooth_and_clamp(
    centers: list[tuple[float, float]],
    frame_w: int,
    frame_h: int,
    sigma: float = 30.0,
) -> list[tuple[float, float]]:
    xs = np.array([c[0] for c in centers])
    ys = np.array([c[1] for c in centers])
    xs = gaussian_filter1d(xs, sigma)
    ys = gaussian_filter1d(ys, sigma)
    crop_w = frame_h * 9.0 / 16.0
    xs = np.clip(xs, crop_w / 2.0, frame_w - crop_w / 2.0)
    ys = np.clip(ys, 0.0, frame_h)
    return list(zip(xs.tolist(), ys.tolist()))


def track_and_encode(
    input_path: Path,
    start: str,
    end: str,
    output_path: Path,
    sample: int = 10,
    sigma: float = 30.0,
) -> None:
    import cv2

    with tempfile.TemporaryDirectory() as tmp:
        tmp_clip = str(Path(tmp) / "clip.mp4")
        tmp_video = str(Path(tmp) / "video_only.mp4")

        # Step A: extract segment (stream copy)
        run_cmd = [
            "ffmpeg", "-y",
            "-ss", start, "-to", end,
            "-i", str(input_path),
            "-c", "copy",
            tmp_clip,
        ]
        print("Extracting clip:", " ".join(run_cmd))
        r = subprocess.run(run_cmd)
        if r.returncode != 0:
            sys.exit(f"ffmpeg extraction failed with exit code {r.returncode}")

        # Step B: get video dimensions
        cap = cv2.VideoCapture(tmp_clip)
        frame_w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
        frame_h = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
        fps = cap.get(cv2.CAP_PROP_FPS) or 25.0
        cap.release()

        # Step C: detect + smooth
        print(f"Detecting faces (every {sample} frames)…")
        raw = _detect_centers(tmp_clip, frame_w, frame_h, sample=sample)
        centers = _smooth_and_clamp(raw, frame_w, frame_h, sigma=sigma)

        # Step D: encode pass (video only)
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
            cropped = frame[0:frame_h, x0 : x0 + crop_w]
            resized = cv2.resize(cropped, (1080, 1920))
            writer.write(resized)
            if (i + 1) % 100 == 0:
                print(f"  encoded {i + 1}/{total} frames")
        cap2.release()
        writer.release()

        # Step E: mux audio from temp clip into final output
        mux_cmd = [
            "ffmpeg", "-y",
            "-i", tmp_video,
            "-i", tmp_clip,
            "-map", "0:v",
            "-map", "1:a?",
            "-c:v", "libx264",
            "-crf", "18",
            "-preset", "fast",
            "-c:a", "aac",
            str(output_path),
        ]
        print("Muxing audio:", " ".join(mux_cmd))
        r = subprocess.run(mux_cmd)
        if r.returncode != 0:
            sys.exit(f"ffmpeg mux failed with exit code {r.returncode}")


def build_filter(fmt: str) -> str | None:
    if fmt == "tiktok":
        # Crop center 9:16 region from a 16:9 source, then scale to 1080x1920
        return "crop=ih*9/16:ih:(iw-ih*9/16)/2:0,scale=1080:1920"
    return None


def main() -> None:
    parser = argparse.ArgumentParser(description="Clip a video segment.")
    parser.add_argument("input", help="Input MP4 file")
    parser.add_argument("-s", "--start", required=True, help="Start time (HH:MM:SS or SS)")
    parser.add_argument("-e", "--end", required=True, help="End time (HH:MM:SS or SS)")
    parser.add_argument(
        "--crop-format",
        choices=["default", "tiktok"],
        default="default",
        dest="crop_fmt",
        help="Crop format (default: keep original; tiktok: static center crop 9:16)",
    )
    parser.add_argument("--output", help="Output file path (default: <input>_clip.<ext>)")
    parser.add_argument(
        "--track-face",
        action="store_true",
        help="Enable face-tracked 9:16 crop",
    )
    parser.add_argument(
        "--track-sample",
        type=int,
        default=10,
        metavar="N",
        help="Run face detection every N frames (default: 10)",
    )
    parser.add_argument(
        "--track-sigma",
        type=float,
        default=30.0,
        metavar="S",
        help="Gaussian smoothing sigma in frames (default: 30 ≈ 1.2 s at 25 fps; lower = faster response, higher = smoother)",
    )
    args = parser.parse_args()

    input_path = Path(args.input)
    if not input_path.exists():
        sys.exit(f"Error: input file not found: {input_path}")

    if args.output:
        output_path = Path(args.output)
    else:
        if args.track_face:
            suffix = "_tiktok_track"
        elif args.crop_fmt == "tiktok":
            suffix = "_tiktok"
        else:
            suffix = "_clip"
        output_path = input_path.with_name(input_path.stem + suffix + input_path.suffix)

    if args.track_face:
        track_and_encode(input_path, args.start, args.end, output_path, sample=args.track_sample, sigma=args.track_sigma)
        print(f"Output: {output_path}")
        return

    vf = build_filter(args.crop_fmt)

    cmd = [
        "ffmpeg", "-y",
        "-ss", args.start,
        "-to", args.end,
        "-i", str(input_path),
    ]
    if vf:
        cmd += ["-vf", vf]
    cmd += [
        "-c:v", "libx264",
        "-crf", "18",
        "-preset", "fast",
        "-c:a", "aac",
        str(output_path),
    ]

    print("Running:", " ".join(cmd))
    result = subprocess.run(cmd)
    if result.returncode != 0:
        sys.exit(f"ffmpeg failed with exit code {result.returncode}")

    print(f"Output: {output_path}")


if __name__ == "__main__":
    main()
