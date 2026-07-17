(() => {
  "use strict";
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => [...document.querySelectorAll(sel)];
  const state = {
    sound: true,
    towns: [],
    scenarios: [],
    selectedScenario: null,
    project: null,
    timer: null,
    seconds: 0,
    voiceAudio: null,
    voiceCues: null,
    voiceReady: null,
    callTimeouts: []
  };
  const callLines = [
    "「聞こえますか？ 2040年の鹿毛馬から電話しています。」",
    "「私の小地域は、定時バスの徒歩圏が100%から0%になりました。」",
    "「使えるワゴンは一台だけ。どこを走れば、いちばん多くの暮らしを救えますか？」",
    "「私は、この町で暮らし続けられますか？」"
  ];

  function setClock() {
    const now = new Date();
    $("#call-clock").textContent = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
  }
  function speak(text) {
    if (!state.sound || !("speechSynthesis" in window)) return;
    speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text.replace(/[「」]/g, ""));
    utterance.lang = "ja-JP";
    utterance.rate = 0.82;
    utterance.pitch = 0.88;
    const voices = speechSynthesis.getVoices();
    utterance.voice = voices.find((v) => v.lang === "ja-JP" && /female|Kyoko|Nanami/i.test(v.name))
      || voices.find((v) => v.lang.startsWith("ja")) || null;
    speechSynthesis.speak(utterance);
  }

  async function prepareGeneratedVoice() {
    try {
      const response = await fetch("./audio/future-call.json", { cache: "no-store" });
      if (!response.ok) return false;
      const metadata = await response.json();
      if (!Array.isArray(metadata.lineStarts) || metadata.lineStarts.length !== callLines.length) return false;
      const audio = new Audio("./audio/future-call.mp3");
      audio.preload = "auto";
      state.voiceAudio = audio;
      state.voiceCues = metadata.lineStarts;
      return true;
    } catch {
      return false;
    }
  }

  function presentCallLine(index, withSpeech = false) {
    $("#resident-line").textContent = callLines[index];
    if (withSpeech) speak(callLines[index]);
    if (index >= 1) $("#evidence-card").hidden = false;
  }

  function finishCall() {
    $("#change-future").hidden = false;
  }

  function runFallbackCall() {
    let lineIndex = 0;
    const showLine = () => {
      presentCallLine(lineIndex, true);
      lineIndex += 1;
      if (lineIndex < callLines.length) {
        const timeout = setTimeout(showLine, lineIndex === 1 ? 3700 : 4700);
        state.callTimeouts.push(timeout);
      } else {
        finishCall();
      }
    };
    showLine();
  }

  function runGeneratedCall() {
    const audio = state.voiceAudio;
    let visibleLine = -1;
    const syncLine = () => {
      const lineIndex = state.voiceCues.reduce(
        (current, start, index) => audio.currentTime >= start ? index : current,
        0
      );
      if (lineIndex !== visibleLine) {
        visibleLine = lineIndex;
        presentCallLine(lineIndex);
      }
    };
    audio.addEventListener("timeupdate", syncLine);
    audio.addEventListener("ended", finishCall, { once: true });
    presentCallLine(0);
    return audio.play().catch(() => {
      audio.removeEventListener("timeupdate", syncLine);
      runFallbackCall();
    });
  }

  async function startCall() {
    $("#incoming-view").hidden = true;
    $("#active-view").hidden = false;
    state.seconds = 0;
    state.timer = setInterval(() => {
      state.seconds += 1;
      $("#call-seconds").textContent = String(state.seconds).padStart(2, "0");
    }, 1000);
    const generatedVoiceAvailable = await state.voiceReady;
    if (generatedVoiceAvailable && state.sound) runGeneratedCall();
    else runFallbackCall();
  }
  $("#answer-call").addEventListener("click", startCall);
  $("#decline-call").addEventListener("click", () => {
    $("#incoming-view h2").textContent = "着信は続いています";
    $("#incoming-view > p:not(.incoming-label)").textContent = "未来は、応答を待っています。";
    $("#decline-call").hidden = true;
  });
  $("#sound-toggle").addEventListener("click", () => {
    state.sound = !state.sound;
    $("#sound-toggle").textContent = `音声 ${state.sound ? "ON" : "OFF"}`;
    $("#sound-toggle").setAttribute("aria-pressed", String(state.sound));
    if (!state.sound && "speechSynthesis" in window) speechSynthesis.cancel();
  });
  $("#change-future").addEventListener("click", () => {
    clearInterval(state.timer);
    state.callTimeouts.forEach(clearTimeout);
    if (state.voiceAudio) state.voiceAudio.pause();
    $("#impact").scrollIntoView({ behavior: "smooth" });
  });
  setClock();
  setInterval(setClock, 30000);
  state.voiceReady = prepareGeneratedVoice();

  function buildStopLossGrid() {
    const grid = $("#stop-loss-grid");
    const fragment = document.createDocumentFragment();
    for (let index = 0; index < 116; index += 1) {
      const dot = document.createElement("span");
      if (index >= 76) dot.className = "is-lost";
      fragment.appendChild(dot);
    }
    grid.appendChild(fragment);
  }
  buildStopLossGrid();

  function geometryPoints(geometry) {
    if (geometry.type === "Polygon") return geometry.coordinates.flat();
    if (geometry.type === "MultiPolygon") return geometry.coordinates.flat(2);
    return [];
  }
  function polygonPath(geometry, project) {
    const rings = geometry.type === "Polygon" ? geometry.coordinates : geometry.coordinates.flat();
    return rings.map((ring) => ring.map(([lon, lat], i) => {
      const [x, y] = project(lon, lat);
      return `${i ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`;
    }).join(" ") + " Z").join(" ");
  }
  async function loadMap() {
    try {
      const [mapResponse, scenarioResponse] = await Promise.all([
        fetch("./towns.geojson"),
        fetch("./wagon-scenarios.json", { cache: "no-store" })
      ]);
      if (!mapResponse.ok || !scenarioResponse.ok) throw new Error("map data unavailable");
      const [geo, scenarioData] = await Promise.all([
        mapResponse.json(),
        scenarioResponse.json()
      ]);
      state.towns = geo.features;
      state.scenarios = scenarioData.scenarios;
      const points = geo.features.flatMap((f) => geometryPoints(f.geometry));
      const lons = points.map((p) => p[0]), lats = points.map((p) => p[1]);
      const minLon = Math.min(...lons), maxLon = Math.max(...lons);
      const minLat = Math.min(...lats), maxLat = Math.max(...lats);
      const scale = Math.min(652 / (maxLon - minLon), 692 / (maxLat - minLat));
      const offsetX = (720 - (maxLon - minLon) * scale) / 2;
      const offsetY = (760 - (maxLat - minLat) * scale) / 2;
      const project = (lon, lat) => [offsetX + (lon - minLon) * scale, offsetY + (maxLat - lat) * scale];
      state.project = project;
      const fragment = document.createDocumentFragment();
      const impactFragment = document.createDocumentFragment();
      geo.features
        .sort((a, b) => (a.properties.elderly_affected || 0) - (b.properties.elderly_affected || 0))
        .forEach((feature) => {
          const p = feature.properties;
          const pathData = polygonPath(feature.geometry, project);
          const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
          path.setAttribute("d", pathData);
          path.setAttribute("tabindex", "0");
          path.setAttribute("role", "button");
          path.setAttribute("aria-label", `${p.name}、65歳以上${p.pop_elderly}人`);
          path.classList.add("town", `town-${p.class}`);
          Object.assign(path.dataset, {
            key: p.key, name: p.name, elderly: p.pop_elderly,
            affected: p.elderly_affected || 0, before: p.frac_before || 0, after: p.frac_after || 0
          });
          path.addEventListener("pointerenter", showTownTooltip);
          path.addEventListener("pointermove", moveTownTooltip);
          path.addEventListener("pointerleave", hideTownTooltip);
          path.addEventListener("focus", showTownTooltip);
          path.addEventListener("blur", hideTownTooltip);
          fragment.appendChild(path);

          const impactPath = document.createElementNS("http://www.w3.org/2000/svg", "path");
          impactPath.setAttribute("d", pathData);
          impactPath.classList.add("impact-town", `impact-town-${p.class}`);
          impactFragment.appendChild(impactPath);
        });
      $("#iizuka-map").appendChild(fragment);
      $("#impact-map").appendChild(impactFragment);
      $("#map-loading").hidden = true;
      renderScenarioList();
      resetScenario();
    } catch (err) {
      $("#map-loading").textContent = "地図データを読み込めませんでした。";
      console.error(err);
    }
  }
  function showTownTooltip(event) {
    const el = event.currentTarget;
    const affected = Number(el.dataset.affected);
    const recovery = Number(el.dataset.recovery || 0);
    const before = Math.round(Number(el.dataset.before) * 1000) / 10;
    const after = Math.round(Number(el.dataset.after) * 1000) / 10;
    const tip = $("#map-tooltip");
    tip.innerHTML = `<b>${escapeHtml(el.dataset.name)}</b><span>65歳以上 ${Number(el.dataset.elderly).toLocaleString("ja-JP")}人</span><span>定時バス徒歩圏 ${before}% → ${after}%</span>${affected ? `<span>影響推計 ${affected.toLocaleString("ja-JP")}人</span>` : ""}${recovery ? `<strong>選択案で回復推計 ${recovery.toLocaleString("ja-JP")}人</strong>` : ""}`;
    tip.hidden = false;
    moveTownTooltip(event);
  }
  function moveTownTooltip(event) {
    if (event.clientX == null) return;
    const wrap = $("#map-wrap").getBoundingClientRect(), tip = $("#map-tooltip");
    tip.style.left = `${Math.min(event.clientX - wrap.left + 14, wrap.width - 220)}px`;
    tip.style.top = `${Math.max(event.clientY - wrap.top - 35, 8)}px`;
  }
  function hideTownTooltip() { $("#map-tooltip").hidden = true; }
  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
  }

  function animateNumber(el, target) {
    const from = Number(el.textContent.replace(/,/g, "")) || 0, start = performance.now(), duration = 480;
    const tick = (now) => {
      const t = Math.min(1, (now - start) / duration), eased = 1 - (1 - t) ** 3;
      el.textContent = Math.round(from + (target - from) * eased).toLocaleString("ja-JP");
      if (t < 1) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }
  function renderScenarioList() {
    $("#scenario-list").innerHTML = state.scenarios.map((scenario) => `
      <button class="scenario-card" type="button" data-scenario="${scenario.id}" aria-pressed="false">
        <span class="scenario-rank">0${scenario.rank}</span>
        <span class="scenario-copy">
          <b>${escapeHtml(scenario.shortName)}</b>
          <small>${escapeHtml(scenario.hospital.name)}へ / ${scenario.corridorKm}km</small>
        </span>
        <strong>${scenario.recoveredElderly.toLocaleString("ja-JP")}<em>人</em></strong>
        ${scenario.recommended ? '<i>DATA BEST</i>' : ""}
      </button>
    `).join("");
    $$(".scenario-card").forEach((card) => {
      card.addEventListener("click", () => {
        const scenario = state.scenarios.find((item) => item.id === card.dataset.scenario);
        selectScenario(scenario);
      });
    });
  }

  function drawScenarioOverlay(scenario) {
    $$(".scenario-overlay").forEach((element) => element.remove());
    if (!scenario || !state.project) return;
    const namespace = "http://www.w3.org/2000/svg";
    const group = document.createElementNS(namespace, "g");
    group.classList.add("scenario-overlay");
    const line = document.createElementNS(namespace, "path");
    const pathData = scenario.routeCoordinates.map(([lon, lat], index) => {
      const [x, y] = state.project(lon, lat);
      return `${index ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`;
    }).join(" ");
    line.setAttribute("d", pathData);
    line.classList.add("scenario-line");
    group.appendChild(line);
    scenario.selectedStops.forEach((stop, index) => {
      const [x, y] = state.project(stop.lon, stop.lat);
      const circle = document.createElementNS(namespace, "circle");
      circle.setAttribute("cx", x.toFixed(1));
      circle.setAttribute("cy", y.toFixed(1));
      circle.setAttribute("r", "6");
      circle.classList.add("scenario-stop");
      const title = document.createElementNS(namespace, "title");
      title.textContent = `${index + 1}. ${stop.name} / 回復推計 ${stop.individualRecovery}人`;
      circle.appendChild(title);
      group.appendChild(circle);
    });
    const [hospitalX, hospitalY] = state.project(scenario.hospital.lon, scenario.hospital.lat);
    const hospital = document.createElementNS(namespace, "circle");
    hospital.setAttribute("cx", hospitalX.toFixed(1));
    hospital.setAttribute("cy", hospitalY.toFixed(1));
    hospital.setAttribute("r", "10");
    hospital.classList.add("scenario-hospital");
    const title = document.createElementNS(namespace, "title");
    title.textContent = scenario.hospital.name;
    hospital.appendChild(title);
    group.appendChild(hospital);
    $("#iizuka-map").appendChild(group);
  }

  function updateJourneyProof(scenario) {
    const example = scenario.residentExample;
    $("#proof-town").textContent = example.town;
    $("#proof-before-coverage").textContent = `${example.beforeCoveragePercent}%`;
    $("#proof-stop").textContent = example.stop;
    $("#proof-hospital").textContent = example.hospital;
    $("#proof-departure").textContent = example.departure;
    $("#proof-arrival").textContent = example.arrival;
    $("#proof-duration").textContent = `${example.durationMinutes}分`;
    $("#proof-recovered").textContent = example.afterRecoveredElderly.toLocaleString("ja-JP");
    $("#journey-proof").hidden = false;
  }

  function selectScenario(scenario) {
    if (!scenario) return;
    state.selectedScenario = scenario;
    $$(".scenario-card").forEach((card) => {
      const selected = card.dataset.scenario === scenario.id;
      card.classList.toggle("selected", selected);
      card.setAttribute("aria-pressed", String(selected));
    });
    $$(".town").forEach((path) => {
      const recovery = Number(scenario.townRecovery[path.dataset.key] || 0);
      path.dataset.recovery = recovery;
      path.classList.remove("town-recovering", "town-partial");
      if (recovery >= 10) path.classList.add("town-recovering");
      else if (recovery > 0) path.classList.add("town-partial");
    });
    drawScenarioOverlay(scenario);
    animateNumber($("#recovered-count"), scenario.recoveredElderly);
    animateNumber($("#recovered-towns"), scenario.recoveredTowns);
    animateNumber($("#selected-stops"), scenario.selectedStops.length);
    $("#outcome-label").textContent = `第${scenario.rank}位 ${scenario.shortName}：${scenario.hospital.name}へ接続`;
    $("#future-reply").textContent = `「${scenario.residentExample.town}から${scenario.hospital.name}へ、もう一度ひとりで行けます。」`;
    $("#scenario-hint").textContent = `${scenario.topTowns.map((town) => town.name).slice(0, 4).join("・")}を中心に、残る徒歩圏空白の${scenario.recoveredShare}%を再接続。`;
    $("#make-report").disabled = false;
    updateJourneyProof(scenario);
  }

  function resetScenario() {
    state.selectedScenario = null;
    $$(".scenario-card").forEach((card) => {
      card.classList.remove("selected");
      card.setAttribute("aria-pressed", "false");
    });
    $$(".town").forEach((path) => {
      path.classList.remove("town-recovering", "town-partial");
      path.dataset.recovery = "0";
    });
    $$(".scenario-overlay").forEach((element) => element.remove());
    animateNumber($("#recovered-count"), 0);
    animateNumber($("#recovered-towns"), 0);
    animateNumber($("#selected-stops"), 0);
    $("#outcome-label").textContent = "4つの配置候補を比較します。";
    $("#future-reply").textContent = "「一台を、どこへ置きますか？」";
    $("#scenario-hint").textContent = "車両・便数・乗降点数を揃えて比較。距離差は各カードに表示しています。";
    $("#make-report").disabled = true;
    $("#journey-proof").hidden = true;
  }

  $("#reset-scenario").addEventListener("click", resetScenario);
  $("#optimize-scenario").addEventListener("click", () => {
    const button = $("#optimize-scenario");
    button.classList.add("is-calculating");
    button.innerHTML = "<span>CALCULATING</span>4候補の徒歩圏を再計算中…";
    setTimeout(() => {
      const recommended = state.scenarios.find((scenario) => scenario.recommended);
      selectScenario(recommended);
      button.classList.remove("is-calculating");
      button.innerHTML = `<span>DATA BEST / #01</span>${escapeHtml(recommended.shortName)}へ配置する`;
    }, 850);
  });

  $("#make-report").addEventListener("click", () => {
    const scenario = state.selectedScenario;
    if (!scenario) return;
    $("#report-id").textContent = `${scenario.id}-0718`;
    $("#report-route").textContent = scenario.shortName;
    $("#report-policies").innerHTML = [
      "追加ワゴン 1台",
      "平日 3往復",
      ...scenario.selectedStops.map((stop) => stop.name)
    ].map((label) => `<span>${escapeHtml(label)}</span>`).join("");
    $("#report-people").textContent = scenario.recoveredElderly.toLocaleString("ja-JP");
    $("#report-towns").textContent = scenario.recoveredTowns;
    $("#report-hospital").textContent = scenario.hospital.name;
    $("#report-message").textContent = scenario.recommended
      ? `4候補中1位。${scenario.recoveredElderly.toLocaleString("ja-JP")}人分の「歩いて乗れる」を、一台で取り戻す。`
      : `${scenario.shortName}では、${scenario.recoveredElderly.toLocaleString("ja-JP")}人分の徒歩圏を取り戻せる。`;
    $("#report").hidden = false;
    $("#report").scrollIntoView({ behavior: "smooth" });
  });
  $("#restart-future").addEventListener("click", () => {
    $("#report").hidden = true; resetScenario(); $("#simulator").scrollIntoView({ behavior: "smooth" });
  });

  document.documentElement.classList.add("motion-ready");
  if ("IntersectionObserver" in window && !window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    const revealObserver = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          entry.target.classList.add("is-visible");
          revealObserver.unobserve(entry.target);
        }
      });
    }, { threshold: 0.18 });
    $$(".reveal").forEach((element) => revealObserver.observe(element));
  } else {
    $$(".reveal").forEach((element) => element.classList.add("is-visible"));
  }
  loadMap();
})();
