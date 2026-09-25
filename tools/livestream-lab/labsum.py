#!/usr/bin/env python3
"""Summarise a device's lab telemetry (logs/app-<device>.jsonl) over a time window.

usage: labsum.py <jsonl> [--since EPOCH_MS] [--until EPOCH_MS] [--timeline]
"""
import json
import sys
from collections import Counter


def load(path, since, until):
    out = []
    with open(path) as f:
        for line in f:
            try:
                rec = json.loads(line)
            except ValueError:
                continue
            msg = rec.get('msg') or rec.get('message') or rec
            at = msg.get('at') or rec.get('receivedAt') or rec.get('at')
            if at is None:
                continue
            if since and at < since:
                continue
            if until and at > until:
                continue
            msg['_at'] = at
            out.append(msg)
    return out


def g(d, *path, default=None):
    for p in path:
        if not isinstance(d, dict):
            return default
        d = d.get(p)
        if d is None:
            return default
    return d


def main():
    args = sys.argv[1:]
    path = args[0]
    since = int(args[args.index('--since') + 1]) if '--since' in args else None
    until = int(args[args.index('--until') + 1]) if '--until' in args else None
    timeline = '--timeline' in args
    msgs = load(path, since, until)
    if not msgs:
        print('no records')
        return
    t0 = since or msgs[0]['_at']
    stats = [m for m in msgs if m.get('type') == 'stats']
    events = [m for m in msgs if m.get('type') in ('state', 'audioOnly')]

    for e in events:
        rel = (e['_at'] - t0) / 1000
        if e['type'] == 'state':
            print(f"  {rel:7.1f}s  state {e.get('state')}{' (' + e['reason'] + ')' if e.get('reason') else ''}")
        else:
            print(f"  {rel:7.1f}s  audioOnly {e.get('audioOnly')}")

    if not stats:
        print('no stats')
        return

    total = 0.0
    frozen = 0.0
    fps_w = 0.0
    kbps_w = 0.0
    watchable = 0.0
    conceal_w = 0.0
    conceal_t = 0.0
    loss_v = 0.0
    loss_a = 0.0
    jb_v = []
    jb_a = []
    quality = Counter()
    limitation = Counter()
    first_fc = last_fc = None
    first_fs = last_fs = None
    est = []
    for m in stats:
        s = m.get('stats') or {}
        dt = s.get('intervalSeconds') or 2
        total += dt
        quality[s.get('quality', m.get('quality'))] += 1
        limitation[s.get('qualityLimitation')] += 1
        v = g(s, 'inbound', 'video')
        a = g(s, 'inbound', 'audio')
        if v:
            frozen += dt * (v.get('frozenPercent') or 0) / 100
            fps_w += dt * (v.get('fps') or 0)
            kbps_w += dt * (v.get('kbps') or 0)
            loss_v += dt * (v.get('lossPercent') or 0)
            if (v.get('fps') or 0) >= 20 and (v.get('frozenPercent') or 0) < 10:
                watchable += dt
            jb_v.append(v.get('jitterBufferMs') or 0)
            fc, fs = v.get('freezeCount'), v.get('freezeSeconds')
            if first_fc is None:
                first_fc, first_fs = fc, fs
            last_fc, last_fs = fc, fs
        if a:
            conceal_w += dt * (a.get('concealedPercent') or 0)
            conceal_t += dt
            loss_a += dt * (a.get('lossPercent') or 0)
            jb_a.append(a.get('jitterBufferMs') or 0)
        if s.get('availableIncomingKbps') is not None:
            est.append(s['availableIncomingKbps'])
        if timeline:
            rel = (m['_at'] - t0) / 1000
            print(
                f"  {rel:7.1f}s {m.get('state', ''):>10} {s.get('quality', ''):>9}/{s.get('qualityLimitation', ''):<7}"
                + (f" v {v.get('width')}x{v.get('height')} {v.get('fps', 0):4.1f}fps {v.get('kbps', 0):6.0f}k"
                   f" loss {v.get('lossPercent', 0):4.1f}% frz {v.get('frozenPercent', 0):3.0f}% jb {v.get('jitterBufferMs', 0):4.0f}"
                   if v else ' v -')
                + (f" | a {a.get('kbps', 0):4.0f}k loss {a.get('lossPercent', 0):4.1f}% conc {a.get('concealedPercent', 0):4.1f}%"
                   f" jb {a.get('jitterBufferMs', 0):4.0f}" if a else ' | a -')
                + (f" | est {s['availableIncomingKbps']:.0f}k" if s.get('availableIncomingKbps') is not None else '')
                + (f" rtt {s['rttMs']:.0f}" if s.get('rttMs') is not None else '')
            )

    def avg(x):
        return sum(x) / len(x) if x else 0

    print(f"  window {total:.0f}s over {len(stats)} samples")
    if total:
        print(f"  video: {fps_w / total:.1f} fps avg, {kbps_w / total:.0f} kbps avg, frozen {100 * frozen / total:.1f}% of the time,"
              f" watchable {100 * watchable / total:.0f}% of the time, loss {loss_v / total:.2f}%")
    if first_fc is not None:
        print(f"         freezes {last_fc - first_fc} ({(last_fs or 0) - (first_fs or 0):.1f}s counted by libwebrtc),"
              f" jitter buffer avg {avg(jb_v):.0f} ms, max {max(jb_v) if jb_v else 0:.0f} ms")
    if conceal_t:
        print(f"  audio: concealed {conceal_w / conceal_t:.2f}% avg, loss {loss_a / conceal_t:.2f}%, jitter buffer avg {avg(jb_a):.0f} ms,"
              f" max {max(jb_a) if jb_a else 0:.0f} ms")
    if est:
        print(f"  downlink estimate avg {avg(est):.0f} kbps (min {min(est):.0f})")
    print(f"  quality: {dict(quality)}  limitation: {dict(limitation)}")


if __name__ == '__main__':
    main()
