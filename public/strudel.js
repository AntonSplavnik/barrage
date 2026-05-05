stack(
  s("[bd <hh cp oh rim>]*2")
    .dec(0.4)
    .delay(0.18)
    .degradeBy(0.5)
    .gain(0.45),

  stack(
    s("[bd]*8")
      .gain(kickVoiceGain * 0.35),

    s("[bd]*2")
      .gain(kickVoiceGain * 0.8)
  ),

  s("[hh]*16")
    .degradeBy(0.5)
    .delay(0.25)
    .gain(0.3),

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
    .add(24),

  note("~ ~ [a4,c5,e5] ~  ~ ~ [c4,e3,b5] ~  ~ ~ [g4,b4,d5] ~  ~ ~ [e3,g#3,b3] ~")
    .sound("sawtooth")
    .legato(0.3)
    .pan(sine.range(0, 1).slow(3))
    .resonance(sine.range(0.1, 0.6).slow(12))
    .add(24)
    .delay(0.55)
    .gain(0.3)
    .fast(0.5)
    .degradeBy(0.25)
)
