`proof-baseline.h264` is two seconds of 1280×800, 30 fps baseline H.264. It has AUDs, repeated
SPS/PPS, no B-frames and a one-second GOP, matching the workspace screen encoder. The solid blue
image keeps the fixture at 8,527 bytes. Generated locally with ffmpeg 9.0.2 and libx264:

```sh
ffmpeg -nostdin -loglevel error -f lavfi -i color=c=0x316ca8:s=1280x800:r=30:d=2 \
  -c:v libx264 -threads 2 -preset ultrafast -tune zerolatency \
  -profile:v baseline -level:v 3.1 -pix_fmt yuv420p -g 30 -keyint_min 30 -bf 0 \
  -x264-params aud=1:repeat-headers=1 -f h264 proof-baseline.h264
```

The tests append an AUD delimiter to expose the last complete access unit to the incremental parser.

`proof-region.h264` uses the same command with `s=640x300` for the dedicated region encoder tests.
