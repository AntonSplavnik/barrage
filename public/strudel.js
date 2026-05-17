stack(
  s("[bd <hh cp oh rim>]*2")
    .bank("RolandTR909")
    .dec(.4)
    .delay(0.5)
    .degradeBy(0.5)
    .gain(0.2 * musicVolume)
    ._pianoroll(),

  // stack(
  //   s("[bd]*8")
  //     .bank("RolandTR909")
  //     .gain((kickVoiceGain / 2) * musicVolume)
  //     ._pianoroll(),

  //   s("[bd]*2")
  //     .bank("RolandTR909")
  //     .gain(kickVoiceGain * musicVolume)
  //     ._pianoroll()
  // ),

  s("[hh]*16")
    .bank("RolandTR909")
    .degradeBy(0.5) // - 0.5 * kickVoiceGain)
    .delay(0.25)
    .gain(0.15 * musicVolume)
    ._pianoroll(),

  note("a1 ~ ~ ~  c2 ~ ~ ~  g1 ~ ~ ~  e1 ~ ~ ~")
    .sound("triangle")
    .legato(1)
    .attack(0.02)
    .release(1.6)
    .lpf(sine.range(200, 1600).slow(8))
    .resonance(sine.range(0.1, 0.6).slow(12))
    .gain(1 * musicVolume)
    .fast(0.5)
    .degradeBy(0.25)
    ._pianoroll(),

  note("~ ~ [a4,c5,e5] ~  ~ ~ [c4,e3,b5] ~  ~ ~ [g4,b4,d5] ~  ~ ~ [e3,g#3,b3] ~")
    .sound("sawtooth")
    .legato(0.3)
    .pan(sine.range(0,1).slow(3))
    .resonance(sine.range(0.1, 0.6).slow(12))
    .delay(0.55)
    .gain(0.3 * musicVolume)
    .fast(0.5)
    .degradeBy(0.25)
    ._pianoroll(),
)
