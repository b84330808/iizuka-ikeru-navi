(() => {
  "use strict";
  const TOTAL_AFFECTED = 3484;
  const BUDGET_MAX = 100;
  const POLICY_LIMIT = 3;
  const POLICY_NAMES = {
    ondemand: "AIオンデマンド交通",
    mobilecare: "移動診療・介護巡回",
    hub: "交流センター生活ハブ",
    restore: "定時路線の重点復活",
    concierge: "予約・移動コンシェルジュ"
  };
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => [...document.querySelectorAll(sel)];
  const state = {
    sound: true,
    policies: new Map(),
    towns: [],
    timer: null,
    seconds: 0,
    lastMetrics: { recoveredPeople: 0, recoveredTowns: 0, score: 28 }
  };
  const callLines = [
    "「聞こえますか？ 2040年の菰田から電話しています。」",
    "「私の町は、定時バスの徒歩圏が92.3%から0%になりました。」",
    "「ワゴンは残っています。でも、医療や介護と別々で、使いこなすのが難しいんです。」",
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
  function startCall() {
    $("#incoming-view").hidden = true;
    $("#active-view").hidden = false;
    state.seconds = 0;
    state.timer = setInterval(() => {
      state.seconds += 1;
      $("#call-seconds").textContent = String(state.seconds).padStart(2, "0");
    }, 1000);
    let lineIndex = 0;
    const showLine = () => {
      $("#resident-line").textContent = callLines[lineIndex];
      speak(callLines[lineIndex]);
      if (lineIndex === 1) $("#evidence-card").hidden = false;
      lineIndex += 1;
      if (lineIndex < callLines.length) setTimeout(showLine, lineIndex === 1 ? 3700 : 4700);
      else $("#change-future").hidden = false;
    };
    showLine();
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
    $("#impact").scrollIntoView({ behavior: "smooth" });
  });
  setClock();
  setInterval(setClock, 30000);

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
      const response = await fetch("./towns.geojson");
      if (!response.ok) throw new Error("map data unavailable");
      const geo = await response.json();
      state.towns = geo.features;
      const points = geo.features.flatMap((f) => geometryPoints(f.geometry));
      const lons = points.map((p) => p[0]), lats = points.map((p) => p[1]);
      const minLon = Math.min(...lons), maxLon = Math.max(...lons);
      const minLat = Math.min(...lats), maxLat = Math.max(...lats);
      const scale = Math.min(652 / (maxLon - minLon), 692 / (maxLat - minLat));
      const offsetX = (720 - (maxLon - minLon) * scale) / 2;
      const offsetY = (760 - (maxLat - minLat) * scale) / 2;
      const project = (lon, lat) => [offsetX + (lon - minLon) * scale, offsetY + (maxLat - lat) * scale];
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
      updateSimulator();
    } catch (err) {
      $("#map-loading").textContent = "地図データを読み込めませんでした。";
      console.error(err);
    }
  }
  function showTownTooltip(event) {
    const el = event.currentTarget;
    const affected = Number(el.dataset.affected);
    const before = Math.round(Number(el.dataset.before) * 1000) / 10;
    const after = Math.round(Number(el.dataset.after) * 1000) / 10;
    const tip = $("#map-tooltip");
    tip.innerHTML = `<b>${escapeHtml(el.dataset.name)}</b><span>65歳以上 ${Number(el.dataset.elderly).toLocaleString("ja-JP")}人</span><span>定時バス徒歩圏 ${before}% → ${after}%</span>${affected ? `<span>影響推計 ${affected.toLocaleString("ja-JP")}人</span>` : ""}`;
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

  function combinedImpact() {
    let remaining = 1;
    state.policies.forEach((policy) => { remaining *= 1 - policy.impact; });
    return 1 - remaining;
  }
  function policyVariation(key, policyId) {
    let hash = 0, text = `${key}:${policyId}`;
    for (let i = 0; i < text.length; i += 1) hash = (hash * 31 + text.charCodeAt(i)) >>> 0;
    return 0.82 + (hash % 37) / 100;
  }
  function townRecoveryRate(path) {
    let remaining = 1;
    state.policies.forEach((policy, id) => {
      remaining *= 1 - Math.min(.85, policy.impact * policyVariation(path.dataset.key, id));
    });
    return 1 - remaining;
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
  function updateAvailability(budget) {
    $$(".policy-card").forEach((card) => {
      const selected = state.policies.has(card.dataset.policy);
      const unavailable = !selected && (Number(card.dataset.cost) > budget || state.policies.size >= POLICY_LIMIT);
      card.classList.toggle("unavailable", unavailable);
      card.disabled = unavailable;
      card.setAttribute("aria-pressed", String(selected));
    });
  }
  function futureReply(impact) {
    if (impact >= .72) return "「病院も、買い物も、ひとりで行ける未来になりました。ここで暮らし続けたいです。」";
    if (impact >= .5) return "「前よりずっと近くなりました。でも、まだ取り残される隣の町があります。」";
    if (impact > 0) return "「一歩、未来が変わりました。もう一つだけ、つながる方法を選べませんか？」";
    return "「まだ、私の未来は変わっていません。」";
  }
  function updateSimulator() {
    const spent = [...state.policies.values()].reduce((sum, p) => sum + p.cost, 0);
    const budget = BUDGET_MAX - spent;
    $("#budget-value").textContent = budget;
    $("#budget-bar").style.width = `${budget}%`;
    $("#budget-bar").style.background = budget < 20 ? "var(--signal)" : "var(--recover)";
    let recoveredPeople = 0, recoveredTowns = 0;
    $$(".town").forEach((path) => {
      path.classList.remove("town-recovering", "town-partial");
      const affected = Number(path.dataset.affected);
      const isTarget = path.classList.contains("town-lost") || path.classList.contains("town-reduced");
      if (!isTarget || !affected || !state.policies.size) return;
      const rate = townRecoveryRate(path);
      recoveredPeople += affected * rate;
      if (rate >= .48) { path.classList.add("town-recovering"); recoveredTowns += 1; }
      else if (rate > .12) path.classList.add("town-partial");
    });
    recoveredPeople = Math.min(TOTAL_AFFECTED, Math.round(recoveredPeople));
    const overall = combinedImpact(), score = Math.min(96, Math.round(28 + overall * 68));
    state.lastMetrics = { recoveredPeople, recoveredTowns, score };
    animateNumber($("#recovered-count"), recoveredPeople);
    animateNumber($("#recovered-towns"), recoveredTowns);
    animateNumber($("#resilience-score"), score);
    $("#outcome-label").textContent = state.policies.size ? `${state.policies.size}つの施策で、生活圏を再計算しました。` : "まだ未来は変わっていません。";
    $("#future-reply").textContent = futureReply(overall);
    $("#make-report").disabled = !state.policies.size;
    updateAvailability(budget);
  }
  $$(".policy-card").forEach((card) => {
    card.addEventListener("click", () => {
      const id = card.dataset.policy;
      if (state.policies.has(id)) {
        state.policies.delete(id); card.classList.remove("selected");
      } else {
        const cost = Number(card.dataset.cost);
        const spent = [...state.policies.values()].reduce((sum, p) => sum + p.cost, 0);
        if (state.policies.size >= POLICY_LIMIT || spent + cost > BUDGET_MAX) {
          $("#policy-hint").textContent = state.policies.size >= POLICY_LIMIT ? "選べる施策は最大3つです。" : "予算が足りません。別の組み合わせを選んでください。";
          return;
        }
        state.policies.set(id, { cost, impact: Number(card.dataset.impact) });
        card.classList.add("selected");
      }
      $("#policy-hint").textContent = state.policies.size ? `${state.policies.size}/3施策を選択中` : "施策を選んでください。";
      updateSimulator();
    });
  });
  function resetPolicies() {
    state.policies.clear();
    $$(".policy-card").forEach((card) => card.classList.remove("selected"));
    $("#policy-hint").textContent = "施策を選んでください。";
    updateSimulator();
  }
  $("#reset-policies").addEventListener("click", resetPolicies);
  $("#make-report").addEventListener("click", () => {
    const { recoveredPeople: people, score } = state.lastMetrics;
    const spent = [...state.policies.values()].reduce((sum, p) => sum + p.cost, 0);
    $("#report-id").textContent = Math.floor(100000 + Math.random() * 900000);
    $("#report-policies").innerHTML = [...state.policies.keys()].map((id) => `<span>${escapeHtml(POLICY_NAMES[id])}</span>`).join("");
    $("#report-people").textContent = people.toLocaleString("ja-JP");
    $("#report-cost").textContent = spent;
    $("#report-score").textContent = score;
    $("#report-message").textContent = score >= 72 ? "「あなたが選んだ未来なら、私はこの町で暮らし続けられます。」" : "未来は動いた。けれど、まだ選び直せる。";
    $("#report").hidden = false;
    $("#report").scrollIntoView({ behavior: "smooth" });
  });
  $("#restart-future").addEventListener("click", () => {
    $("#report").hidden = true; resetPolicies(); $("#simulator").scrollIntoView({ behavior: "smooth" });
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
  updateSimulator();
})();
