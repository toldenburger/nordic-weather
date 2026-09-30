// Run with: npm test  (pins TZ=Europe/Stockholm so local-time output is stable)
const test = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const M = require("./load-model.js")

const fixture = (name) => fs.readFileSync(path.join(__dirname, "fixtures", name), "utf8")
const repoFile = (name) => fs.readFileSync(path.join(__dirname, "..", name), "utf8")
const alingsas = M.parseTimeseries(fixture("forecast-alingsas.json"))
const bergen = M.parseTimeseries(fixture("forecast-bergen.json"))
const singapore = M.parseTimeseries(fixture("forecast-singapore.json"))
const nowcastAlingsas = M.parseTimeseries(fixture("nowcast-alingsas.json"))
const moon = M.parseMoon(fixture("moon-alingsas.json"), Date.parse("2026-09-26T10:00:00Z"))
const sun = M.parseSun(fixture("sun-alingsas.json"))
// 14:44 local, just after the Alingsås fixtures were fetched.
const NOW = Date.parse("2026-09-26T12:44:00Z")

test("runs in the expected zone", () => {
  assert.equal(new Date(NOW).getHours(), 14)
})

test("language follows locale, English fallback", () => {
  assert.equal(M.langFor("nl_NL"), "nl")
  assert.equal(M.langFor("nl_BE.UTF-8"), "nl")
  assert.equal(M.langFor("NL"), "nl")
  assert.equal(M.langFor("en_US"), "en")
  assert.equal(M.langFor("de_DE"), "en")
  assert.equal(M.langFor("sv_SE"), "en")
  assert.equal(M.langFor("nlx"), "en")
  assert.equal(M.langFor("nds_NL"), "en")
  assert.equal(M.langFor(""), "en")
})

// Every language has what English has, of the same shape: a new one that
// misses a string or a grammar form fails here, not on screen.
test("languages: every entry is complete", () => {
  // Lists are fixed-size (months, compass points, grammar forms), except
  // how many locale prefixes a language has.
  const shape = (v, key) => Array.isArray(v) ? (key === "locales" ? "array" : "array:" + v.length)
    : typeof v === "object" ? "object" : typeof v
  const walk = (ref, other, where) => {
    for (const key of Object.keys(ref)) {
      assert.ok(key in other, `${where}.${key} missing`)
      assert.equal(shape(other[key], key), shape(ref[key], key), `${where}.${key}`)
      if (shape(ref[key]) === "object") walk(ref[key], other[key], `${where}.${key}`)
    }
    for (const key of Object.keys(other)) assert.ok(key in ref, `${where}.${key} not in English`)
  }
  for (const lang of Object.keys(M.STRINGS)) {
    walk(M.STRINGS.en, M.STRINGS[lang], lang)
    for (const kind of ["rain", "sleet", "snow", "light", "heavy"])
      assert.ok(M.STRINGS[lang].precip[kind].every((w) => w !== ""), `${lang}.precip.${kind}`)
  }
})

test("Dutch: descriptions, dates, numbers and hours", () => {
  assert.equal(M.describeSymbol("clearsky_day", "nl"), "Helder")
  assert.equal(M.describeSymbol("lightrain", "nl"), "Lichte regen")
  assert.equal(M.describeSymbol("heavyrainshowersandthunder_day", "nl"), "Zware regenbuien en onweer")
  assert.equal(M.describeSymbol("sleetshowers_night", "nl"), "Buien met natte sneeuw")
  assert.equal(M.describeSymbol("lightssnowshowersandthunder_night", "nl"), "Lichte sneeuwbuien en onweer")
  const today = Date.parse("2026-09-26T00:00:00+02:00")
  assert.equal(M.dayTitle(Date.parse("2026-09-28T00:00:00+02:00"), today, "nl"), "Maandag 28 sep")
  assert.equal(M.dayTitle(today, today, "nl"), "Vandaag 26 sep")
  assert.equal(M.formatNumber(0.4, 1, "nl"), "0,4")
  assert.equal(M.formatPrecip(0.2, 0, 1.4, "nl"), "0–1,4 mm")
  assert.ok(M.geocodeUrl("Amsterdam", "nl").endsWith("&language=nl"))
  const frames = [0, 1, 2].map((h) => ({ timeMs: h * 3600000 }))
  assert.deepEqual(M.rulerTicks(frames, 1, "nl").map((t) => t.stamp), ["−1 u", "Nu", "+1 u"])
})

test("numbers use a decimal comma in Dutch", () => {
  assert.equal(M.formatNumber(0.4, 1, "nl"), "0,4")
  assert.equal(M.formatNumber(0.4, 1, "en"), "0.4")
  assert.equal(M.formatNumber(1.0, 1, "nl"), "1")
  assert.equal(M.roundTemp(-0.3), 0)
  assert.ok(!Object.is(M.roundTemp(-0.3), -0))
})

test("time parsing", () => {
  assert.equal(M.parseIsoMs("2026-09-26T12:00:00Z"), Date.UTC(2026, 8, 26, 12))
  assert.equal(M.parseIsoMs("2026-09-26T07:02+02:00"), Date.UTC(2026, 8, 26, 5, 2))
  assert.equal(M.parseHttpDateMs("Sat, 26 Sep 2026 13:14:28 GMT"), Date.UTC(2026, 8, 26, 13, 14, 28))
  assert.ok(Number.isNaN(M.parseIsoMs("nope")))
})

test("sunrise offset follows DST for the date asked about", () => {
  assert.equal(M.utcOffsetString(Date.parse("2026-07-01T12:00:00Z")), "+02:00")
  assert.equal(M.utcOffsetString(Date.parse("2026-12-01T12:00:00Z")), "+01:00")
  // Day after the October switch (Oct 25 2026).
  assert.equal(M.utcOffsetString(Date.parse("2026-10-26T12:00:00Z")), "+01:00")
})

test("coordinates are truncated to 4 decimals in URLs", () => {
  const loc = { name: "Alingsås", latitude: 57.930331, longitude: 12.533452, elevation: 66.4 }
  assert.equal(M.forecastUrl(loc),
    "https://api.met.no/weatherapi/locationforecast/2.0/complete?lat=57.9303&lon=12.5335&altitude=66")
  assert.match(M.sunUrl(loc, NOW), /date=2026-09-26&offset=%2B02%3A00$/)
  assert.ok(!M.forecastUrl({ latitude: 1, longitude: 2 }).includes("altitude"))
})

test("curl command identifies itself and sends If-Modified-Since", () => {
  const cmd = M.curlCommand("https://x", "Sat, 26 Sep 2026 12:44:00 GMT", 10, "agent/1")
  assert.equal(cmd[cmd.indexOf("-A") + 1], "agent/1")
  assert.ok(cmd.includes("If-Modified-Since: Sat, 26 Sep 2026 12:44:00 GMT"))
  assert.ok(!M.curlCommand("https://x", "").includes("-H"))
})

test("every request caps the response size", () => {
  const cap = (cmd) => cmd[cmd.indexOf("--max-filesize") + 1]
  assert.equal(cap(M.curlCommand("https://x", "", 10, "agent/1")), String(M.MAX_RESPONSE_BYTES))
  const geocode = M.geocodeCommand("Amsterdam", "nl", "agent/1")
  assert.equal(cap(geocode), String(M.MAX_RESPONSE_BYTES))
  assert.equal(geocode[geocode.indexOf("-A") + 1], "agent/1")
  assert.equal(geocode.at(-1), M.geocodeUrl("Amsterdam", "nl"))
})

test("an oversized compressed response is cut off at the cap", { skip: !fs.existsSync("/usr/bin/curl") && "curl not installed" }, async () => {
  const http = require("node:http")
  const zlib = require("node:zlib")
  const { spawn } = require("node:child_process")
  // ~40 KB on the wire, 4× the cap once decompressed.
  const body = zlib.gzipSync(Buffer.alloc(4 * M.MAX_RESPONSE_BYTES, "0"))
  const server = http.createServer((req, res) => {
    res.writeHead(200, { "Content-Encoding": "gzip", "Content-Type": "application/json" })
    res.end(body)
  })
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  try {
    const cmd = M.curlCommand("http://127.0.0.1:" + server.address().port + "/", "", 10, "agent/1")
    const { code, bytes } = await new Promise((resolve) => {
      const proc = spawn(cmd[0], cmd.slice(1))
      let bytes = 0
      proc.stdout.on("data", (chunk) => { bytes += chunk.length })
      proc.on("close", (code) => resolve({ code, bytes }))
    })
    assert.equal(code, 63)  // curl: maximum file size exceeded
    assert.ok(bytes <= M.MAX_RESPONSE_BYTES + 4096, bytes + " bytes")
  } finally {
    server.close()
  }
})

test("HTTP response parsing and cache policy", () => {
  const raw = "HTTP/2 200 \r\nexpires: Sat, 26 Sep 2026 13:14:28 GMT\r\nLast-Modified: Sat, 26 Sep 2026 12:44:00 GMT\r\n\r\n{\"a\":1}"
  const r = M.parseHttpResponse(raw)
  assert.equal(r.status, 200)
  assert.equal(r.body, "{\"a\":1}")
  const entry = M.cacheEntryFromResponse(null, "k", r, NOW)
  assert.equal(entry.lastModified, "Sat, 26 Sep 2026 12:44:00 GMT")
  assert.ok(M.isFresh(entry, "k", NOW))
  assert.ok(!M.isFresh(entry, "other", NOW))
  assert.ok(!M.isFresh(entry, "k", Date.UTC(2026, 8, 26, 13, 15)))

  const notModified = M.parseHttpResponse("HTTP/2 304 \r\nexpires: Sat, 26 Sep 2026 13:45:00 GMT\r\n\r\n")
  const renewed = M.cacheEntryFromResponse(entry, "k", notModified, NOW)
  assert.equal(renewed.body, "{\"a\":1}")
  assert.equal(renewed.expiresMs, Date.UTC(2026, 8, 26, 13, 45))

  const unsupported = M.parseHttpResponse("HTTP/2 422 \r\n\r\n" + fixture("nowcast-singapore-422.txt"))
  assert.equal(unsupported.status, 422)
  assert.equal(M.parseTimeseries(unsupported.body), null)
})

test("symbol descriptions in both languages", () => {
  assert.equal(M.describeSymbol("clearsky_day", "nl"), "Helder")
  assert.equal(M.describeSymbol("partlycloudy_night", "en"), "Partly cloudy")
  assert.equal(M.describeSymbol("lightrain", "nl"), "Lichte regen")
  assert.equal(M.describeSymbol("heavyrainshowers_day", "nl"), "Zware regenbuien")
  assert.equal(M.describeSymbol("sleetshowersandthunder_night", "nl"), "Buien met natte sneeuw en onweer")
  assert.equal(M.describeSymbol("heavysnow", "en"), "Heavy snow")
  assert.equal(M.describeSymbol("rainshowersandthunder_day", "en"), "Rain showers and thunder")
})

test("MET's misspelled symbol codes map to the real ones", () => {
  assert.equal(M.describeSymbol("lightssleetshowersandthunder_day", "en"), "Light sleet showers and thunder")
  assert.equal(M.describeSymbol("lightssnowshowersandthunder_night", "nl"), "Lichte sneeuwbuien en onweer")
  assert.equal(M.iconForSymbol("lightssnowshowersandthunder_night"), M.iconForSymbol("lightsnowshowersandthunder_night"))
})

test("every MET base symbol has a description and a specific icon", () => {
  const bases = ["clearsky", "fair", "partlycloudy", "cloudy", "fog"]
  for (const i of ["light", "", "heavy"])
    for (const k of ["rain", "sleet", "snow"])
      for (const sh of ["", "showers"])
        for (const th of ["", "andthunder"]) bases.push(i + k + sh + th)
  assert.equal(bases.length, 41)
  for (const b of bases) {
    for (const v of ["", "_day", "_night"]) {
      const code = b + v
      for (const lang of ["nl", "en"]) {
        const text = M.describeSymbol(code, lang)
        assert.ok(text.length > 0 && text[0] === text[0].toUpperCase(), code + " " + lang)
        assert.ok(!/^[a-z]+$/.test(text), "untranslated: " + code)
      }
      const icon = M.iconForSymbol(code)
      assert.equal(icon.length, 1, code)
      assert.ok(icon.charCodeAt(0) >= 0xe300 && icon.charCodeAt(0) <= 0xe3ff, code)
    }
  }
})

test("night icons: clear/fair nights use the crescent, never a phase disc", () => {
  assert.equal(M.iconForSymbol("clearsky_night"), "\ue32b")
  assert.equal(M.iconForSymbol("fair_night"), "\ue32b")
  assert.equal(M.iconForSymbol("clearsky_day"), "\ue30d")
  assert.equal(M.iconForSymbol("partlycloudy_night"), "\ue37e")
  assert.equal(M.iconForSymbol("clearsky_polartwilight"), "\ue30d")
})

test("moon phase glyphs (footer only)", () => {
  assert.equal(M.moonGlyph(0), "\ue38d")    // new
  assert.equal(M.moonGlyph(180), "\ue39b")  // full
  assert.equal(M.moonGlyph(90), "\ue394")   // first quarter
  assert.equal(M.moonGlyph(355), "\ue38d")  // wraps to new
})

test("moon illumination", () => {
  const at = (deg) => M.buildView({ moon: { phaseDeg: deg, refMs: NOW, highMs: NaN },
                                    lang: "nl", nowMs: NOW }).moon.illumination
  assert.equal(at(0), 0)
  assert.equal(at(90), 50)
  assert.equal(at(180), 100)
  assert.equal(at(270), 50)
})

test("moon phase advances between days", () => {
  const today = M.moonPhaseAt(moon, moon.refMs)
  const tomorrow = M.moonPhaseAt(moon, moon.refMs + 86400000)
  assert.ok(Math.abs(today - 170.8) < 0.1)
  assert.ok(Math.abs(tomorrow - today - 12.19) < 0.05)
})

test("wind compass and arrow", () => {
  assert.equal(M.windCompass(259, "nl"), "W")
  assert.equal(M.windCompass(259, "en"), "W")
  assert.equal(M.windCompass(45, "nl"), "NO")
  assert.equal(M.windArrow(259), "→")  // from the west, blowing east
  assert.equal(M.windArrow(0), "↓")
})

test("precipitation formatting", () => {
  assert.equal(M.formatPrecip(0, 0, 0, "nl"), "")
  assert.equal(M.formatPrecip(0.04, 0.04, 0.04, "nl"), "<0,1 mm")
  assert.equal(M.formatPrecip(0.4, 0.4, 0.4, "nl"), "0,4 mm")
  assert.equal(M.formatPrecip(0.6, 0.2, 1.4, "nl"), "0,2–1,4 mm")
  assert.equal(M.formatPrecip(0, 0, 0.3, "en"), "0–0.3 mm")
})

test("forecast parsing keeps periods", () => {
  assert.equal(alingsas.steps.length, 86)
  assert.equal(alingsas.steps[0].period1.symbol, "clearsky_day")
  assert.equal(alingsas.steps[0].period6.details.air_temperature_max, 15.2)
  const lastHourly = alingsas.steps.filter((s) => s.period1).pop()
  assert.ok(lastHourly.ms > NOW + 48 * 3600000)
})

test("current conditions use the step nearest now", () => {
  const c = M.buildCurrent(alingsas, null, NOW, "nl")
  const nearest = alingsas.steps.find((s) => s.ms === Date.parse("2026-09-26T13:00:00Z"))
  assert.equal(c.temp, Math.round(nearest.instant.air_temperature))
  assert.equal(c.description, M.describeSymbol(nearest.period1.symbol, "nl"))
  assert.equal(c.wind.dirLabel, M.windCompass(nearest.instant.wind_from_direction, "nl"))
})

test("current conditions prefer a fresh nowcast", () => {
  const nc = M.parseTimeseries(fixture("nowcast-alingsas.json"))
  const at = nc.steps[0].ms
  const c = M.buildCurrent(alingsas, nc, at, "en")
  assert.equal(c.temp, Math.round(nc.steps[0].instant.air_temperature))
  // Only the first step carries temperature; it stays in use for 30 min
  // (the bar refetches every 15), then the model takes over again.
  const modelTempAt = (ms) => Math.round(alingsas.steps.reduce((a, b) => Math.abs(b.ms - ms) < Math.abs(a.ms - ms) ? b : a).instant.air_temperature)
  const ncTemp = 23.4  // distinct from the model so the source is unambiguous
  const tweaked = JSON.parse(JSON.stringify(nc))
  tweaked.steps[0].instant.air_temperature = ncTemp
  assert.equal(M.buildCurrent(alingsas, tweaked, at + 14 * 60000, "en").temp, 23)
  assert.equal(M.buildCurrent(alingsas, tweaked, at + 29 * 60000, "en").temp, 23)
  assert.equal(M.buildCurrent(alingsas, tweaked, at + 31 * 60000, "en").temp, modelTempAt(at + 31 * 60000))
  // A stale nowcast (hours later) is ignored.
  const later = M.buildCurrent(alingsas, nc, at + 5 * 3600000, "en")
  const step = alingsas.steps.reduce((a, b) => Math.abs(b.ms - (at + 5 * 3600000)) < Math.abs(a.ms - (at + 5 * 3600000)) ? b : a)
  assert.equal(later.temp, Math.round(step.instant.air_temperature))
})

test("pressure: now and its forecast change over 3 hours", () => {
  const step = (h, p) => ({ ms: h * 3600000, instant: { air_pressure_at_sea_level: p } })
  const fc = { steps: [step(0, 1010), step(1, 1011), step(2, 1012), step(3, 1013), step(4, 1013.4)] }
  assert.equal(M.pressureAt(fc.steps, 1.5 * 3600000), 1011.5)
  assert.equal(M.pressureAt(fc.steps, 5 * 3600000), null)
  // 1010.5 → 1013.2: rising, not yet steep.
  assert.deepEqual(M.buildPressure(fc, 0.5 * 3600000, "nl"),
    { value: 1011, change: 2.7, arrow: "\u2197", changeText: "+2,7 over 3 u" })
  // Past the forecast's end there's no change to show.
  assert.deepEqual(M.buildPressure(fc, 3 * 3600000, "en"), { value: 1013, change: null, arrow: "", changeText: "" })
  const falling = { steps: [step(0, 1020), step(3, 1016.5)] }
  assert.equal(M.buildPressure(falling, 0, "en").arrow, "\u2193")
  assert.equal(M.buildPressure(falling, 0, "en").changeText, "\u22123.5 in 3 h")
  const flat = { steps: [step(0, 1020), step(3, 1020.4)] }
  assert.equal(M.buildPressure(flat, 0, "en").arrow, "\u2192")
  assert.equal(M.buildPressure({ steps: [step(0, 1020), step(3, 1020)] }, 0, "nl").changeText, "\u00b10 over 3 u")
  // From the fixture: a plausible sea-level pressure.
  const p = M.buildCurrent(alingsas, null, NOW, "nl").pressure
  assert.ok(p.value > 950 && p.value < 1060 && p.changeText !== "")
})

test("hourly days: 3 h steps, then 6 h steps past the hourly range", () => {
  const days = M.buildHourlyDays(alingsas, NOW, 3, 3, "nl")
  assert.deepEqual(days.map((d) => d.title), ["Vandaag 26 sep", "Morgen 27 sep", "Maandag 28 sep"])
  assert.deepEqual(days[0].rows.map((r) => r.hour), ["15", "18", "21"])
  assert.deepEqual(days[1].rows.map((r) => r.hour), ["00", "03", "06", "09", "12", "15", "18", "21"])
  for (const day of days) for (const r of day.rows) assert.ok(r.ms >= Date.parse("2026-09-26T12:00:00Z"))
  // Upcoming times only: the 15 row shows until 15:00 local, then goes.
  const today = (iso) => M.buildHourlyDays(alingsas, Date.parse(iso), 3, 3, "nl")[0].rows.map((r) => r.hour)
  assert.deepEqual(today("2026-09-26T12:57:00Z"), ["15", "18", "21"])
  assert.deepEqual(today("2026-09-26T13:00:00Z"), ["18", "21"])
  assert.deepEqual(today("2026-09-26T13:57:00Z"), ["18", "21"])
  // The day after tomorrow is always 6-hour rows, even when a later
  // forecast run covers it hourly (simulated: every step gets a 1 h period).
  const allHourly = { steps: alingsas.steps.map((st) => Object.assign({}, st, { period1: st.period1 || st.period6 })) }
  const later = M.buildHourlyDays(allHourly, NOW, 3, 3, "nl")
  assert.equal(later[1].sixHour, false)
  assert.equal(later[2].sixHour, true)
  assert.deepEqual(later[2].rows.map((r) => r.hour), ["02", "08", "14", "20"])
  // Hourly data runs out on Monday evening, so all of Monday is 6-hour rows.
  assert.equal(days[1].sixHour, false)
  assert.equal(days[2].sixHour, true)
  assert.deepEqual(days[2].rows.map((r) => r.hour), ["02", "08", "14", "20"])
  assert.ok(days[2].rows.every((r) => r.periodHours === 6))
  // The 6-hour row uses the 6-hour period even where hourly data exists.
  const mon02 = alingsas.steps.find((s) => s.ms === Date.parse("2026-09-28T00:00:00Z"))
  assert.equal(days[2].rows[0].description, M.describeSymbol(mon02.period6.symbol, "nl"))
  assert.equal(M.buildHourlyDays(alingsas, NOW, 3, 3, "en")[2].title, "Monday Sep 28")
})

test("day precipitation glyph follows the most likely kind", () => {
  const row = (kind, probability, temp) => ({ temp: temp, precip: { kind: kind, probability: probability } })
  assert.equal(M.precipGlyph([row("", 0, 5), row("rain", 40, 3)]), "\ue371")
  assert.equal(M.precipGlyph([row("rain", 20, 1), row("snow", 60, -1)]), "\ue36f")
  assert.equal(M.precipGlyph([row("sleet", 50, 1), row("snow", 30, 0)]), "\ue371\ue36f")
  // No precipitation symbol: snow only when every row is frozen.
  assert.equal(M.precipGlyph([row("", 0, -4), row("", 5, -1)]), "\ue36f")
  assert.equal(M.precipGlyph([row("", 0, -4), row("", 5, 1)]), "\ue371")
  assert.equal(M.precipGlyph([row("", 0, null)]), "\ue371")
  const days = M.buildHourlyDays(alingsas, NOW, 3, 3, "nl")
  assert.ok(days.every((d) => d.precipGlyph === M.precipGlyph(d.rows)))
})

test("hourly rows carry precipitation, spread and wind", () => {
  const days = M.buildHourlyDays(bergen, bergen.steps[0].ms, 1, 3, "nl")
  const rows = days.flatMap((d) => d.rows)
  const wet = rows.find((r) => r.precip.text !== "")
  assert.ok(wet, "Bergen fixture should have precipitation")
  assert.match(wet.precip.text, /mm$/)
  assert.ok(rows.every((r) => r.wind.arrow.length === 1))
  assert.ok(rows.every((r) => r.tempSpread >= 0))
})

test("long range: one row per day, today first, sane values", () => {
  const days = M.buildLongRange(alingsas, NOW, 10, "nl")
  assert.equal(days[0].day, "Vandaag")
  assert.equal(days[1].day, "Zo")
  assert.ok(days.length >= 10)
  for (const d of days) {
    assert.ok(d.min <= d.max, JSON.stringify(d))
    assert.equal(d.icon.length, 1)
  }
  // Evening: only night periods remain today, but the overview still shows a day icon.
  const evening = M.buildLongRange(alingsas, Date.parse("2026-09-26T19:00:00Z"), 1, "nl")[0]
  assert.equal(evening.day, "Vandaag")
  assert.ok(!["\ue32b", "\ue37e"].includes(evening.icon), "night icon in overview")
  const wet = M.buildLongRange(singapore, singapore.steps[0].ms, 10, "en")
  assert.ok(wet.some((d) => d.precip !== ""), "Singapore fixture should have precipitation")
})

test("long range precipitation does not double count overlapping periods", () => {
  const days = M.buildLongRange(bergen, bergen.steps[0].ms, 10, "en")
  const total = days.reduce((sum, d) => sum + (d.precip ? parseFloat(d.precip) : 0), 0)
  let expected = 0
  let covered = -Infinity
  for (const s of bergen.steps) {
    const p = s.period1 || s.period6
    if (p && s.ms >= covered) { expected += p.details.precipitation_amount || 0; covered = s.ms + p.hours * 3600000 }
  }
  assert.ok(Math.abs(total - expected) < 0.5, total + " vs " + expected)
})

test("nowcast summary", () => {
  const dry = M.buildNowcast(nowcastAlingsas, nowcastAlingsas.steps[0].ms, "nl")
  assert.match(dry.summary, /^Droog de komende \d+ min$/)
  assert.equal(dry.wet, false)

  const wetLater = JSON.parse(JSON.stringify(nowcastAlingsas))
  wetLater.steps[4].instant.precipitation_rate = 0.5
  wetLater.steps[4].period1 = { hours: 1, symbol: "lightrain", details: {} }
  assert.equal(M.buildNowcast(wetLater, wetLater.steps[0].ms, "nl").summary, "Regen over ca. 20 min")

  const stopping = JSON.parse(JSON.stringify(nowcastAlingsas))
  for (let i = 0; i < 3; i++) stopping.steps[i].instant.precipitation_rate = 1.2
  assert.equal(M.buildNowcast(stopping, stopping.steps[0].ms, "en").summary, "Precipitation now, stopping in ~15 min")

  const noCoverage = JSON.parse(JSON.stringify(nowcastAlingsas))
  noCoverage.meta.radar_coverage = "temporarily unavailable"
  assert.equal(M.buildNowcast(noCoverage, noCoverage.steps[0].ms, "nl"), null)
})

test("sun and moon", () => {
  const view = M.buildView({ forecast: alingsas, sun, moon, location: { name: "Alingsås", latitude: 57.93, longitude: 12.53 },
                             lang: "nl", nowMs: NOW, settings: {} })
  assert.deepEqual(view.sun, { rise: "07:03", set: "18:58" })
  assert.equal(view.moon.name, "Volle maan")  // 171°, within ±22.5° of full
  assert.equal(view.moon.high, "hoogst 01:08")
  const noHigh = Object.assign({}, moon, { highMs: NaN })
  assert.equal(M.buildView({ moon: noHigh, lang: "en", nowMs: NOW }).moon.high, "")
  assert.equal(M.buildView({ moon, lang: "en", nowMs: NOW }).moon.high, "highest 01:08")
  assert.equal(view.moon.illumination, 99)  // 171°
})

test("full view model", () => {
  const view = M.buildView({ forecast: alingsas, nowcast: nowcastAlingsas, sun, moon,
                             location: { name: "Alingsås", latitude: 57.93, longitude: 12.53 },
                             lang: "nl", nowMs: NOW, settings: { hourStep: 3, hourlyDays: 3, longRangeDays: 10 } })
  assert.equal(view.ready, true)
  assert.equal(view.location.set, true)
  assert.equal(view.bar.text, view.current.icon + " " + view.current.temp + "°")
  assert.equal(view.days.length, 3)
  // The overview continues where the hourly sections stop (Tue 29 Sep).
  assert.equal(view.longRange[0].day, "Di")
  const hourlyStarts = view.days.map((d) => d.start)
  assert.ok(view.longRange.every((d) => !hourlyStarts.includes(d.start)))
  assert.ok(view.longRange.length >= 7 && view.longRange.length <= 10)
  const twoHourly = M.buildView({ forecast: alingsas, location: { name: "A", latitude: 57.93, longitude: 12.53 },
                                  lang: "nl", nowMs: NOW, settings: { hourlyDays: 2 } })
  assert.equal(twoHourly.longRange[0].day, "Ma")
  // Late in the evening today has no hourly rows left, and isn't listed in
  // the overview either: the hourly sections are Sun and Mon, then Tue.
  const late = M.buildView({ forecast: alingsas, location: { name: "A", latitude: 57.93, longitude: 12.53 },
                             lang: "nl", nowMs: Date.parse("2026-09-26T20:30:00Z"), settings: { hourlyDays: 3 } })
  assert.deepEqual(late.days.map((d) => d.title.split(" ")[0]), ["Morgen", "Maandag"])
  assert.equal(late.longRange[0].day, "Di")
  assert.ok(view.longRangeScale.min <= view.longRangeScale.max)
  assert.equal(view.updatedAt, "14:30")
  const note = M.notification(view)
  assert.match(note.headline, /^Alingsås {2}· {2}Helder \d+°$/)
  assert.match(note.body, /^Wind \d+ m\/s \S+ {2}· {2}Droog/)
  assert.equal(note.glyph, view.current.icon)
})

test("summary line for scripts", () => {
  const view = M.buildView({ forecast: alingsas, nowcast: nowcastAlingsas, sun, moon,
                             location: { name: "Alingsås", latitude: 57.93, longitude: 12.53 },
                             lang: "nl", nowMs: NOW, settings: {} })
  assert.match(M.summaryText(view), /^Alingsås · Helder \d+° · Wind \d+ m\/s \S+ · Droog/)
  assert.equal(M.summaryText(M.buildView({ lang: "en", nowMs: NOW, location: { name: "", latitude: null, longitude: null } })),
    "Choose a place to see the weather")
  assert.equal(M.summaryText(M.buildView({ lang: "nl", nowMs: NOW, location: { name: "A", latitude: 57.9, longitude: 12.5 } })),
    "Voorspelling ophalen…")
})

test("view without forecast or location", () => {
  const view = M.buildView({ lang: "en", nowMs: NOW, location: { name: "", latitude: null, longitude: null } })
  assert.equal(view.ready, false)
  assert.equal(view.location.set, false)
  assert.equal(view.bar.text, "")
  assert.equal(M.notification(view), null)
})

test("location file and geocoding", () => {
  assert.deepEqual(M.parseLocationFile('{"name":"Alingsås","latitude":57.93033,"longitude":12.53345}'),
    { name: "Alingsås", latitude: 57.93033, longitude: 12.53345 })
  assert.deepEqual(M.parseLocationFile("garbage"), { name: "", latitude: null, longitude: null })
  assert.deepEqual(M.parseLocationFile('{"name":"Malibu"}'), { name: "Malibu", latitude: null, longitude: null })

  const results = M.parseGeocodingResults(fixture("geocode-alings.json"))
  assert.equal(results[0].name, "Alingsås")
  assert.equal(results[0].description, "Västra Götalands län, Sverige")
  assert.equal(typeof results[0].elevation, "number")
  assert.deepEqual(M.parseGeocodingResults(fixture("geocode-empty.json")), [])
  assert.equal(M.geocodeUrl("Göte borg", "nl"),
    "https://geocoding-api.open-meteo.com/v1/search?name=G%C3%B6te%20borg&count=6&format=json&language=nl")

  assert.equal(M.locationCommit("alings", results, 0), results[0])
  assert.equal(M.locationCommit("alings", results, 99), results[results.length - 1])
  assert.equal(M.locationCommit("", results, 0), null)
  assert.equal(M.locationCommit("x", [], 0), null)
})

test("Buienradar's rain coverage box and the marker's position on its render", () => {
  assert.equal(M.hasRainCoverage({ latitude: 52.37, longitude: 4.89 }), true)   // Amsterdam
  assert.equal(M.hasRainCoverage({ latitude: 50.85, longitude: 4.35 }), true)   // Brussels (fringe)
  assert.equal(M.hasRainCoverage({ latitude: 40, longitude: 4.89 }), false)     // south of the box
  assert.equal(M.hasRainCoverage({ latitude: 52.37, longitude: 20 }), false)    // east of the box
  assert.equal(M.hasRainCoverage({ latitude: null, longitude: null }), false)

  // The centre of the coverage box lands near the centre of the render.
  const centre = M.radarMarkerPosition((49.5 + 54.8) / 2, 5)
  assert.ok(Math.abs(centre.x - M.BR_RADAR_WIDTH / 2) < M.BR_RADAR_WIDTH * 0.1)
  assert.ok(Math.abs(centre.y - M.BR_RADAR_HEIGHT / 2) < M.BR_RADAR_HEIGHT * 0.1)
  assert.equal(M.radarMarkerPosition(40, 4.89), null)  // outside the box
  assert.equal(M.radarMarkerPosition(null, 4.89), null)
})

const BR_NOW_INDEX = M.BR_RADAR_HISTORY - 1

test("Buienradar radar timeline: history then nowcast, with the now marker", () => {
  const { frames, nowIndex } = M.radarFrames(fixture("buienradar-radar.json"))
  assert.equal(frames.length, 18)
  assert.equal(nowIndex, BR_NOW_INDEX)
  assert.equal(frames[nowIndex].forecast, false)
  assert.equal(frames[nowIndex + 1].forecast, true)
  assert.ok(frames.every((f, i) => i === 0 || f.timeMs > frames[i - 1].timeMs))
  assert.deepEqual(M.radarFrames(""), { frames: [], nowIndex: -1 })
  // Garbage times/urls are dropped, not crashed on.
  assert.deepEqual(M.parseRadarIndex('{"times":[{"timestamp":"nope","url":"x"},{"timestamp":"2026-09-26T12:00:00Z","url":""}]}'), [])

  // Every frame's id and cache file follow its exact image URL: a forecast
  // frame refreshed with a new URL (Buienradar reruns its nowcast) gets a
  // new id, so a loop never stitches together images from different runs;
  // an observation's URL is stable, so it keeps the same cache file.
  const a = M.radarFrameId({ timeMs: 5, url: "https://x/run1/5.png" })
  const b = M.radarFrameId({ timeMs: 5, url: "https://x/run2/5.png" })
  assert.notEqual(a, b)
  assert.equal(M.radarFrameId({ timeMs: 5, url: "https://x/run1/5.png" }), a)
  assert.match(M.radarFrameFile(frames[0]), /^f_\d+_[0-9a-z]+\.png$/)
  assert.equal(M.radarFrameFile(frames[0]), M.radarFrameFile(Object.assign({}, frames[0])))

  assert.equal(M.mapFrameLabel(frames[nowIndex], "nl"), "14:55")
  assert.equal(M.mapFrameLabel(frames[nowIndex + 1], "nl"), "Voorspelling 15:00")
  assert.equal(M.mapFrameLabel(frames[nowIndex + 1], "en"), "Forecast 15:00")
  assert.equal(M.mapFrameLabel(null, "nl"), "")
})

test("radar frame-list keys follow the frames' images", () => {
  const f = (url, timeMs) => ({ url, timeMs })
  const a = [f("https://x/1.png", 1), f("https://x/2.png", 2), f("https://x/now1/3.png", 3)]
  assert.equal(M.radarFramesKey(a), M.radarFramesKey(a.map((x) => ({ ...x }))))
  // A new forecast run, or a frame more or less, changes the key.
  assert.notEqual(M.radarFramesKey(a), M.radarFramesKey([f("https://x/1.png", 1), f("https://x/2.png", 2), f("https://x/now2/3.png", 3)]))
  assert.notEqual(M.radarFramesKey(a), M.radarFramesKey([f("https://x/1.png", 1), f("https://x/now1/3.png", 3)]))
  assert.equal(M.radarFramesKey([]), "")
})

test("radar frame download fetches only missing frames and never keeps failures", () => {
  const { execFileSync } = require("node:child_process")
  const os = require("node:os")
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "br-radar-"))
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), "br-fakecurl-"))
  const log = path.join(bin, "calls")
  // Fake curl: logs its URLs; writes each -o target unless the URL contains "missing".
  fs.writeFileSync(path.join(bin, "curl"), `#!/bin/bash
out=""
for a in "$@"; do
  [[ $prev == --max-filesize ]] && echo "max $a" >> "${log}"
  [[ $a == --remove-on-error ]] && echo "remove-on-error" >> "${log}"
  if [[ $prev == -o ]]; then out=$a
  elif [[ $a == http* ]]; then echo "$a" >> "${log}"; [[ $a == *missing* ]] || printf 'PNG' > "$out"
  fi
  prev=$a
done
`, { mode: 0o755 })
  const frames = [
    { timeMs: 1, url: "http://t/cached" },
    { timeMs: 2, url: "http://t/fresh" },
    { timeMs: 3, url: "http://t/missing" }
  ]
  fs.writeFileSync(path.join(dir, M.radarFrameFile(frames[0])), "cached")
  const cmd = M.radarDownloadCommand(dir, frames, "agent/1")
  const out = execFileSync(cmd[0], cmd.slice(1), { env: { ...process.env, PATH: bin + ":" + process.env.PATH } }).toString().trim()
  assert.equal(out, "2 1")  // two were not cached; one of them failed and is still missing
  assert.deepEqual(fs.readFileSync(log, "utf8").trim().split("\n"),
                   ["max " + M.MAX_TILE_BYTES, "remove-on-error", "http://t/fresh", "http://t/missing"])
  assert.equal(fs.readFileSync(path.join(dir, M.radarFrameFile(frames[0])), "utf8"), "cached")
  assert.equal(fs.readFileSync(path.join(dir, M.radarFrameFile(frames[1])), "utf8"), "PNG")
  assert.ok(!fs.existsSync(path.join(dir, M.radarFrameFile(frames[2]))))
  assert.deepEqual(fs.readdirSync(dir).filter((f) => f.endsWith(".part")), [])
})

test("Model.js is a shared, stateless QML library", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "Model.js"), "utf8")
  assert.equal(source.split("\n")[0], ".pragma library")
  // A .pragma library can't reach QML objects or the Qt global.
  assert.doesNotMatch(source.replace(/\/\/.*$/gm, ""), /\bQt\.|\bQuickshell\b|\broot\./)
})

test("time ruler: tallest at now, falling off to both ends, stamped at whole hours from now", () => {
  const t0 = Date.parse("2026-09-27T07:50:00Z")  // 09:50 local
  const frames = Array.from({ length: 7 }, (_, i) => ({ timeMs: t0 + i * 300000, forecast: i > 2 }))
  const ticks = M.rulerTicks(frames, 2, "nl")
  assert.deepEqual(ticks.map((t) => t.level), [0.5, 0.75, 1, 0.75, 0.5, 0.25, 0])
  assert.deepEqual(ticks.map((t) => t.stamp), ["", "", "Nu", "", "", "", ""])
  assert.deepEqual(ticks.map((t) => t.forecast), [false, false, false, true, true, true, true])
  assert.equal(new Set(ticks.map((t) => t.key)).size, ticks.length)
  // A new "now" changes the levels, so the keys change too (ScriptModel).
  assert.notEqual(M.rulerTicks(frames, 3, "nl")[0].key, ticks[0].key)
  // No observations: the ruler peaks at the first frame.
  assert.equal(M.rulerTicks(frames, -1, "nl")[0].level, 1)
  assert.deepEqual(M.rulerTicks([], 0, "nl"), [])
  assert.deepEqual(M.rulerTicks([frames[0]], 0, "en").map((t) => t.stamp), ["Now"])
  // A loop like yr.no's: 17 observations up to now, 23 forecast frames.
  // Stamps sit a whole number of hours from now, whatever the clock says.
  const now = Date.parse("2026-09-27T08:07:00Z") - 7 * 60000 + 300000   // 10:05 local, not a full hour
  const loop = Array.from({ length: 41 }, (_, i) => ({ timeMs: now + (i - 17) * 300000, forecast: i > 17 }))
  const stamps = M.rulerTicks(loop, 17, "en").map((t, i) => [i, t.stamp]).filter(([, s]) => s)
  assert.deepEqual(stamps, [[5, "\u22121 h"], [17, "Now"], [29, "+1 h"]])
})

test("radar: rotating slots retain decoded endpoints across advancement and wrap", () => {
  const frames = Array.from({ length: 5 }, (_, i) => ({ timeMs: i * 300000 }))
  let prev = M.radarImageSlots(frames, 0, 0)
  for (let tick = 1; tick <= 12; tick++) {
    const next = M.radarImageSlots(frames, tick % frames.length, tick)
    assert.equal(next.current, prev.upcoming)
    assert.equal(next.frames[next.current], prev.frames[prev.upcoming])
    assert.equal(next.frames.filter((f, i) => f !== prev.frames[i]).length, 1)
    prev = next
  }
  for (const n of [1, 2]) {
    const a = M.radarImageSlots(frames.slice(0, n), 0, 0)
    const b = M.radarImageSlots(frames.slice(0, n), 1 % n, 1)
    assert.deepEqual(a.frames, b.frames)
  }
  assert.deepEqual(M.radarImageSlots([], 0, 0).frames, [null, null, null])
})

test("radar: one frame per tick, wrapping at the end", () => {
  // Every published loop is complete (Buienradar's whole timeline is a
  // handful of images, so unlike the old tile system there is no partial
  // loop to wait on while more arrives).
  const frames = Array.from({ length: 10 }, (_, i) => ({ timeMs: i * 300000 }))
  const slots = M.radarImageSlots(frames, 5, 5)
  assert.equal(slots.frames[slots.current], frames[5])
  assert.deepEqual(M.radarStep(3, 3, 10), { frame: 4, tick: 4 })
  assert.deepEqual(M.radarStep(9, 9, 10), { frame: 0, tick: 10 })  // wraps at the end
  assert.deepEqual(M.radarStep(0, 2, 1), { frame: 0, tick: 2 })    // a single frame never advances
  assert.deepEqual(M.radarStep(0, 2, 0), { frame: 0, tick: 2 })    // no frames
})

test("radar: a replacement loop carries on at the same time", () => {
  const frames = [300000, 600000, 900000].map((timeMs) => ({ timeMs }))
  assert.equal(M.radarFrameAt(frames, 600000), 1)
  assert.equal(M.radarFrameAt(frames, 450000), 1)   // between frames: the next one
  assert.equal(M.radarFrameAt(frames, 0), 0)        // dropped off the start
  assert.equal(M.radarFrameAt(frames, 1200000), 0)  // past the end: from the start
  assert.equal(M.radarFrameAt([], 0), 0)
})

test("list keys: unique, stable for unchanged content, new for changed content", () => {
  const build = (nowMs) => M.buildView({ forecast: alingsas, nowcast: nowcastAlingsas, sun, moon,
    location: { name: "Alingsås", latitude: 57.93, longitude: 12.53 }, lang: "nl", nowMs, settings: {} })
  const a = build(NOW), b = build(NOW + 60000)
  const rowKeys = (v) => v.days.flatMap((d) => d.rows.map((r) => r.key))
  for (const keys of [rowKeys(a), a.days.map((d) => d.key), a.longRange.map((d) => d.key)])
    assert.equal(new Set(keys).size, keys.length, "keys must be unique (ScriptModel requirement)")
  // A minute later nothing in the rows changed: same keys, so no rebuilds.
  assert.deepEqual(rowKeys(b), rowKeys(a))
  assert.deepEqual(b.longRange.map((d) => d.key), a.longRange.map((d) => d.key))
  // Changed content → changed key.
  const changed = JSON.parse(JSON.stringify(a.days[0].rows[0])); changed.temp += 1
  assert.notEqual(M.contentKey ? M.contentKey(changed) : null, a.days[0].rows[0].key)
  // Radar frames, search suggestions and nowcast points carry keys too.
  const frames = M.radarFrames(fixture("buienradar-radar.json")).frames
  assert.equal(new Set(frames.map((f) => M.radarFrameId(f))).size, frames.length)
  assert.ok(M.parseGeocodingResults(fixture("geocode-alings.json")).every((r) => typeof r.key === "string"))
  assert.ok(a.nowcast.points.every((p) => typeof p.key === "string"))
})

test("favourites: parsed, keyed by coordinates, capped", () => {
  const text = JSON.stringify([
    { name: "Alingsås", description: "Västra Götaland, Sverige", latitude: 57.93033, longitude: 12.53345, elevation: 58 },
    { name: "Alingsås again", latitude: 57.93034, longitude: 12.53346 },  // same place, rounded
    { name: "", latitude: 1, longitude: 2 },
    { name: "Nowhere" },
    { name: " Göteborg ", latitude: "57.70716", longitude: "11.96679" }
  ])
  const favs = M.parseFavorites(text)
  assert.deepEqual(favs.map((f) => f.name), ["Alingsås", "Göteborg"])
  assert.deepEqual(favs[1], { name: "Göteborg", description: "", latitude: 57.70716, longitude: 11.96679, elevation: null })
  assert.deepEqual(M.parseFavorites("oops"), [])
  const many = Array.from({ length: 12 }, (_, i) => ({ name: "P" + i, latitude: 60 + i, longitude: 10 }))
  assert.equal(M.parseFavorites(JSON.stringify(many)).length, M.FAVORITES_MAX)
})

test("favourites: toggle, remove, rows and stepping", () => {
  const a = { name: "Alingsås", latitude: 57.9303, longitude: 12.5335 }
  const g = { name: "Göteborg", description: "Västra Götaland, Sverige", latitude: 57.7072, longitude: 11.9668, elevation: 12 }
  const b = { name: "Borås", latitude: 57.721, longitude: 12.9401 }
  let favs = M.toggleFavorite([], a)
  favs = M.toggleFavorite(favs, g)
  assert.deepEqual(favs.map((f) => f.name), ["Alingsås", "Göteborg"])
  assert.equal(favs[1].elevation, 12)
  assert.ok(M.isFavorite(favs, { name: "renamed", latitude: 57.93031, longitude: 12.53349 }))
  assert.deepEqual(M.toggleFavorite(favs, a).map((f) => f.name), ["Göteborg"])
  assert.deepEqual(M.removeFavorite(favs, M.placeKey(g)).map((f) => f.name), ["Alingsås"])
  assert.deepEqual(M.toggleFavorite(favs, { name: "No place" }), favs)
  const full = Array.from({ length: M.FAVORITES_MAX }, (_, i) => ({ name: "P" + i, latitude: 60 + i, longitude: 10 }))
  assert.equal(M.toggleFavorite(full, a), full)
  // Rows: the current place marked.
  const rows = M.favoriteRows(favs, a)
  assert.deepEqual(rows.map((r) => r.current), [true, false])
  assert.equal(rows[1].placeKey, M.placeKey(g))
  assert.notEqual(rows[0].key, rows[1].key)
  // Stepping wraps; from a place that isn't a favourite, the first one.
  const three = favs.concat([b])
  assert.equal(M.stepFavorite(three, a, 1).name, "Göteborg")
  assert.equal(M.stepFavorite(three, a, -1).name, "Borås")
  assert.equal(M.stepFavorite(three, b, 1).name, "Alingsås")
  assert.equal(M.stepFavorite(three, { name: "X", latitude: 1, longitude: 1 }, 1).name, "Alingsås")
  assert.equal(M.stepFavorite([a], a, 1), null)
  assert.equal(M.stepFavorite([], a, 1), null)
})

// The User-Agent (MET's terms) carries the manifest's id and version; the
// plugin id is also a constant (it names the cache before the manifest
// arrives), so it must match.
test("user agent and id come from the manifest", () => {
  const manifest = JSON.parse(repoFile("manifest.json"))
  assert.equal(M.PLUGIN_ID, manifest.id)
  assert.equal(M.userAgent(manifest), manifest.id + "/" + manifest.version + " github.com/toldenburger/nordic-weather")
  assert.ok(M.userAgent(null).startsWith(manifest.id + "/dev "))
})

test("requests are throttled per service", () => {
  for (const kind of ["forecast", "sun", "moon"]) assert.equal(M.requestService(kind), "met")
  for (const kind of ["nowcast", "radar"]) assert.equal(M.requestService(kind), "br")
})

test("radar is shown only while our copy is recent and not awaiting a refresh", () => {
  const now = Date.parse("2026-09-29T08:30:00Z")
  const radar = { nowIndex: 1, frames: [{ timeMs: now - 3000000 }, { timeMs: now - 2700000 }, { timeMs: now + 300000 }] }
  const min = 60000
  assert.equal(M.radarUsable(radar, now, false, now - 5 * min), true)
  assert.equal(M.radarUsable(radar, now, false, now - 30 * min), true)
  // Last night's copy after a sleep, or offline for long: not shown.
  assert.equal(M.radarUsable(radar, now, false, now - 31 * min), false)
  assert.equal(M.radarUsable(radar, now, false, now - 600 * min), false)
  assert.equal(M.radarUsable(radar, now, false, NaN), false)
  // Buienradar running late (newest observation 45 min old) but just fetched: shown.
  assert.equal(M.radarUsable(radar, now, false, now - min), true)
  // Waiting for the refresh started on opening: nothing yet.
  assert.equal(M.radarUsable(radar, now, true, now), false)
  assert.equal(M.radarUsable({ frames: [], nowIndex: -1 }, now, false, now), false)
  assert.equal(M.radarUsable(null, now, false, now), false)
})

test("radar delay note: only when Buienradar's newest observation is late", () => {
  const now = Date.parse("2026-09-29T11:57:00Z")
  assert.equal(M.radarDelayNote(now - 10 * 60000, now, "nl"), "")
  assert.equal(M.radarDelayNote(Date.parse("2026-09-29T11:15:00Z"), now, "nl"), "Radar van 13:15")
  assert.equal(M.radarDelayNote(Date.parse("2026-09-29T11:15:00Z"), now, "en"), "Radar from 13:15")
  assert.equal(M.radarDelayNote(0, now, "nl"), "")
})

test("place search: duplicate results are dropped (list keys must be unique)", () => {
  const r = { name: "Göteborg", latitude: 57.70716, longitude: 11.96679, admin1: "Västra Götaland", country: "Sverige" }
  const out = M.parseGeocodingResults(JSON.stringify({ results: [r, r, Object.assign({}, r, { latitude: 57.8 })] }))
  assert.equal(out.length, 2)
  assert.equal(new Set(out.map((x) => x.key)).size, 2)
})

test("radar gap note: only when frames are missing from the loop", () => {
  const at = (minutes) => minutes.map((m) => ({ timeMs: m * 60000 }))
  assert.equal(M.radarGapNote(at([0, 5, 10, 15]), "en"), "")
  // An outage: 13:15 → 13:55 with nothing between.
  assert.equal(M.radarGapNote(at([0, 5, 10, 50, 55]), "en"), "Gaps in the radar: expect time jumps between frames")
  assert.equal(M.radarGapNote(at([0, 5, 10, 50]), "nl"), "Hiaten in de radar – de tijd kan springen tussen beelden")
  assert.equal(M.radarGapNote([], "en"), "")
})
