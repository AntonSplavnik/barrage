stack(
  s("[bd <hh cp oh rim>]*2")
    .bank("tr909")
    .dec(.4)
    .delay(0.5)
    .degradeBy(0.5)
    .gain(0.5)
    ._pianoroll(),

  stack(
    s("[bd]*8")
      .bank("tr909")
      .gain(kickVoiceGain / 2)
      ._pianoroll(),

    s("[bd]*2")
      .bank("tr909")
      .gain(kickVoiceGain)
      ._pianoroll()
  ),

  s("[hh]*16")
    .degradeBy(0.5)
    .delay(0.25)
    .gain(0.5)
    ._pianoroll(),

  note("a1 ~ ~ ~  c2 ~ ~ ~  g1 ~ ~ ~  e1 ~ ~ ~")
    .sound("triangle")
    .legato(1)
    .attack(0.02)
    .release(1.6)
    .lpf(sine.range(200, 1600).slow(8))
    .resonance(sine.range(0.1, 0.6).slow(12))
    .gain(1)
    .fast(0.5)
    .degradeBy(0.25)
    .add(24)
    ._pianoroll(),

  note("~ ~ [a4,c5,e5] ~  ~ ~ [c4,e3,b5] ~  ~ ~ [g4,b4,d5] ~  ~ ~ [e3,g#3,b3] ~")
    .sound("saw")
    .legato(0.3)
    .pan(sine.range(0,1).slow(3))
    .resonance(sine.range(0.1, 0.6).slow(12))
    .add(24)
    .delay(0.55)
    .gain(0.3)
    .fast(0.5)
    .degradeBy(0.25)
    .add(0)
    ._pianoroll(),
)
