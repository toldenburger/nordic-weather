import QtQuick
import Quickshell
import "." as Weather

Scope {
  id: test
  property int stage: 0
  property double started: Date.now()
  property double since: Date.now()
  property int savedFrame: 0
  property int savedTick: 0
  property var seenKeys: []
  // Index times are offsets from here (set by service.test.js), so the
  // newest observation is recent: older radar isn't shown (Model.radarUsable).
  property double base: Number(Quickshell.env("RADAR_TEST_BASE"))

  // Exercise the actual service, processes and worker (real curl fetches
  // against file:// sources service.test.js prepares) without touching the
  // network or the user's location/settings.
  Weather.Service {
    id: service
    location: ({ name: "Test", latitude: 52.37, longitude: 4.89 })
    function maybeFetch(force) {}
    function setLocationIfChanged(next) {}
  }
  Connections {
    target: service
    function onRadarKeyChanged() { if (service.radarKey !== "") test.seenKeys.push(service.radarKey) }
  }
  Weather.RadarImages {
    id: images
    loop: service.imageLoop
    playhead: service.shownValid ? service.radarPlayhead : ({ frame: 0, tick: 0 })
    directory: service.tilesDir
    token: service.radarToken
    onPrepared: function(token, ready) { service.radarImagesPrepared(token, ready) }
  }

  function check(ok, description) {
    if (!ok) throw new Error(description)
  }
  function next() { stage++; since = Date.now() }
  function viewer(open) {
    service.updateViewer("test", { open: open, radarOpen: open, width: 256, height: 192 })
    // The real index fetch is stubbed out (maybeFetch is a no-op) in favour
    // of index() below, so nothing ever answers the "awaiting a refresh on
    // open" wait itself; clear it here instead of waiting out its timeout.
    if (open) service.radarAwaiting = false
  }
  // Each frame's url is a file:// source service.test.js writes; label picks
  // which set of source images to point at ("A", "B", "fail" …).
  function index(label, times, fetchedMs) {
    var now = fetchedMs === undefined ? Date.now() : fetchedMs
    service.cache = Object.assign({}, service.cache, { radar: {
      key: "x",
      body: JSON.stringify({ times: times.map(function(t) {
        // Buienradar's real metadata has no zone suffix at all (confirmed
        // against the live endpoint), unlike toISOString()'s "...Z" — match
        // that exactly, since Service.qml must parse the real shape, not a
        // convenient one.
        return { timestamp: new Date(test.base + t).toISOString().replace(/\.\d+Z$/, ""),
                 url: "file://" + Quickshell.env("RADAR_TEST_SOURCES") + "/" + label + "-" + t + ".png" }
      }) }),
      fetchedMs: now, expiresMs: now + 600000
    } })
  }

  function step() {
    if (Date.now() - started > 15000) throw new Error("timeout at stage " + stage)
    if (stage === 0 && service.cacheLoaded) {
      service.cache = {}
      // Set the index before opening, so the radar never waits on a
      // refresh (isDue sees a fresh-enough entry already there).
      index("A", [0, 300000, 600000, 900000, 1200000, 1500000, 1800000, 2100000])
      viewer(true)
      next()
    } else if (stage === 1 && service.shownValid && service.radarImagesReady && service.radarPlayhead.tick > 1) {
      service.togglePause()
      savedFrame = service.radarFrame
      next()
    } else if (stage === 2 && Date.now() - since > 300) {
      check(service.radarFrame === savedFrame, "pause must hold the frame")
      service.seekFrame(1)
      check(service.radarFrame === 1 && service.radarPaused, "seek must select a frame and stay paused")
      service.togglePause()
      // A later, overlapping index: the frame at 600000 is common to both.
      index("B", [300000, 600000, 900000, 1200000, 1500000, 1800000, 2100000, 2400000])
      next()
    } else if (stage === 3 && service.shownValid && service.radarImagesReady
               && service.shownLoop.frames[0].url.indexOf("/B-") >= 0) {
      // Replaced at the step from 5 min (frame 1 of the first loop) to
      // 10 min: the second loop carries on at 10 min or later, not at 5.
      check(service.currentFrame.timeMs >= 600000, "a new loop carries on at the same time")
      savedFrame = service.radarFrame
      savedTick = service.radarPlayhead.tick
      viewer(false)
      next()
    } else if (stage === 4 && Date.now() - since > 300) {
      check(service.radarFrame === savedFrame && service.radarPlayhead.tick === savedTick, "closed radar must not animate")
      viewer(true)
      // Every frame's source is missing: the download must fail and retry,
      // never silently "succeed" with an empty loop.
      index("fail", [3000000, 3300000, 3600000, 3900000, 4200000, 4500000, 4800000, 5100000])
      next()
    } else if (stage === 5) {
      if (service.radarRetryCount !== 1) return
      check(service.radarDoneKey === "", "a failed download must not be marked done")
      next()
    } else if (stage === 6) {
      // Radar from hours ago (the computer slept): not shown, even though
      // its index technically parses fine.
      index("A", [-10800000, -10500000, -10200000, -9900000, -9600000, -9300000, -9000000], Date.now() - 10800000)
      check(!service.radarFresh && service.radarData.frames.length === 0, "old radar is not shown")
      check(!service.shownValid, "a stale index is never published")
      next()
    } else if (stage === 7) {
      // Frames that vanish from disk: the loop is dropped and refetched,
      // instead of holding on a frame forever.
      service.shownLoop = { frames: [{ timeMs: 0, url: "x" }], key: "vanished" }
      service.radarDoneKey = "done"
      service.radarImagesFailed()
      check(!service.shownValid && service.radarDoneKey === "", "missing frames reload instead of freezing")
      check(seenKeys.length >= 3, "every index change must be seen exactly once (onRadarKeyChanged)")
      console.log("RADAR_SERVICE_PASS")
      Qt.quit()
    }
  }
  Timer {
    interval: 10
    running: true
    repeat: true
    onTriggered: {
      try { test.step() } catch (error) {
        console.error("RADAR_SERVICE_FAIL " + error)
        Qt.quit()
      }
    }
  }
}
