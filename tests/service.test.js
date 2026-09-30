const test = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const os = require("node:os")
const { spawnSync, execFileSync } = require("node:child_process")
const M = require("./load-model")

test("Quickshell: service publishes, pauses, replaces loops and retries failed downloads", {
  skip: !fs.existsSync("/usr/bin/qs") || !fs.existsSync("/usr/share/omarchy/shell/Commons")
    || !fs.existsSync("/usr/bin/magick") ? "Quickshell, Omarchy and ImageMagick required" : false
}, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nl-radar-service-"))
  try {
    for (const file of ["Service.qml", "RadarImages.qml", "Model.js"])
      fs.copyFileSync(path.join(__dirname, "..", file), path.join(dir, file))
    fs.copyFileSync(path.join(__dirname, "qml", "service.qml"), path.join(dir, "shell.qml"))
    fs.symlinkSync("/usr/share/omarchy/shell/Commons", path.join(dir, "Commons"))
    const cache = path.join(dir, "cache")
    fs.mkdirSync(path.join(cache, M.PLUGIN_ID, "tiles"), { recursive: true })

    // Real (but local, file://) source images for the fixture's "A" and "B"
    // indexes; curl fetches these into the cache for real, exercising the
    // actual download command. "fail"'s sources are deliberately absent.
    const sources = path.join(dir, "sources")
    fs.mkdirSync(sources, { recursive: true })
    const timesFor = { A: [0, 300000, 600000, 900000, 1200000, 1500000, 1800000, 2100000],
                        B: [300000, 600000, 900000, 1200000, 1500000, 1800000, 2100000, 2400000] }
    for (const [label, times] of Object.entries(timesFor))
      for (const t of times)
        execFileSync("magick", ["-size", "8x8", `xc:rgb(${(t / 300000) % 256},100,200)`,
          path.join(sources, `${label}-${t}.png`)])

    const base = Math.floor(Date.now() / 300000) * 300000 - 1800000
    const runtime = path.join(dir, "runtime")
    fs.mkdirSync(runtime, { mode: 0o700 })
    const result = spawnSync("qs", ["-p", path.join(dir, "shell.qml"), "--no-color"], {
      encoding: "utf8", timeout: 20000,
      env: { ...process.env, QT_QPA_PLATFORM: "offscreen", QT_QUICK_BACKEND: "software",
        XDG_RUNTIME_DIR: runtime, XDG_CACHE_HOME: cache, QML_DISABLE_DISK_CACHE: "1",
        RADAR_TEST_BASE: String(base), RADAR_TEST_SOURCES: sources }
    })
    const output = (result.stdout || "") + (result.stderr || "")
    assert.equal(result.status, 0, (result.error || "") + output)
    assert.match(output, /RADAR_SERVICE_PASS/, output)
    assert.doesNotMatch(output, /RADAR_SERVICE_FAIL|ReferenceError|TypeError|Binding loop/)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
