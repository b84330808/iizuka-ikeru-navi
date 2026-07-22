(function () {
  "use strict";

  const $ = (selector) => document.querySelector(selector);
  const $$ = (selector) => [...document.querySelectorAll(selector)];
  const CATEGORY_LABELS = {
    hospital: "通院", life: "買い物", city: "行政手続き", community: "交流・活動"
  };
  const REASON_LABELS = {
    no_matching_service: "希望時刻に便がない",
    service_closed: "運行日・運行時間外",
    registration_required: "登録・予約手続きが壁",
    booking_expired: "予約期限を過ぎた",
    wagon_schedule: "ワゴン時刻が合わない",
    fixed_route: "定時便で移動可能",
    on_demand_available: "予約交通で移動可能",
    unknown: "その他"
  };
  const AREA_POINTS = {
    "頴田": [130.721, 33.683], "鯰田": [130.704, 33.670],
    "幸袋": [130.697, 33.676], "鎮西": [130.648, 33.640],
    "二瀬": [130.668, 33.650], "穂波": [130.675, 33.610],
    "筑穂": [130.648, 33.570], "飯塚東": [130.707, 33.633],
    "庄内": [130.729, 33.638], "菰田": [130.691, 33.627],
    "立岩": [130.690, 33.650], "飯塚・片島": [130.683, 33.638],
    "位置情報周辺": [130.687, 33.642]
  };
  const SCENARIO_AREAS = { KI: "頴田", TC: "鎮西", SI: "庄内", CI: "筑穂" };
  const DEMO_BLUEPRINTS = [
    ["頴田", "頴田病院", "hospital", 19, 18, ["no_matching_service", "service_closed"]],
    ["穂波", "飯塚記念病院", "hospital", 17, 19, ["booking_expired", "registration_required"]],
    ["菰田", "飯塚記念病院", "hospital", 15, 19, ["wagon_schedule", "no_matching_service"]],
    ["鎮西", "イオン穂波店", "life", 14, 21, ["no_matching_service", "service_closed"]],
    ["庄内", "飯塚市役所", "city", 12, 20, ["no_matching_service", "registration_required"]],
    ["筑穂", "済生会飯塚嘉穂病院", "hospital", 13, 18, ["service_closed", "no_matching_service"]],
    ["二瀬", "飯塚病院", "hospital", 11, 19, ["booking_expired", "registration_required"]],
    ["幸袋", "ゆめタウン飯塚", "life", 10, 22, ["no_matching_service", "wagon_schedule"]],
    ["鯰田", "飯塚市総合体育館", "community", 9, 25, ["service_closed", "no_matching_service"]],
    ["飯塚東", "飯塚市役所", "city", 8, 20, ["no_matching_service", "registration_required"]],
    ["立岩", "飯塚病院", "hospital", 7, 18, ["no_matching_service", "service_closed"]],
    ["飯塚・片島", "イオン穂波店", "life", 8, 23, ["no_matching_service", "service_closed"]]
  ];

  const state = {
    liveEvents: [], demoEvents: [], scenarios: [], project: null,
    selectedArea: "all", selectedScenarios: [], persistence: false
  };

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, (char) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    }[char]));
  }

  function isoDate(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }

  function createDemoEvents() {
    const now = new Date();
    const events = [];
    DEMO_BLUEPRINTS.forEach(([area, destination, category, count, baseBucket, reasons], areaIndex) => {
      for (let index = 0; index < count; index += 1) {
        const createdAt = new Date(now.getTime() - (((index * 5 + areaIndex * 3) % 29) * 86400000) - ((index * 37) % 12) * 3600000);
        const requested = new Date(createdAt.getTime() + ((index % 4) + 1) * 86400000);
        const friction = index % 5 === 2;
        const served = index % 4 === 0;
        const outcome = served ? (index % 8 === 0 ? "reservation" : "served") : friction ? "friction" : "gap";
        const reason = outcome === "served" ? "fixed_route"
          : outcome === "reservation" ? "on_demand_available"
          : friction ? (index % 2 ? "registration_required" : "booking_expired")
          : reasons[index % reasons.length];
        events.push({
          id: `demo-${areaIndex}-${index}`,
          createdAt: createdAt.toISOString(),
          originArea: area,
          destinationName: destination,
          category,
          requestedDate: isoDate(requested),
          hourBucket: Math.max(12, Math.min(37, baseBucket + ((index % 5) - 2))),
          outcome,
          reason,
          journeyType: outcome === "served" ? "fixed" : outcome === "reservation" ? "on_demand" : "unresolved",
          source: "demo"
        });
      }
    });
    return events;
  }

  function normalizeLiveEvent(row) {
    return {
      id: row.id,
      createdAt: row.created_at,
      originArea: row.origin_area,
      destinationName: row.destination_name,
      category: row.category,
      requestedDate: row.requested_date,
      hourBucket: Number(row.hour_bucket),
      outcome: row.outcome,
      reason: row.reason,
      journeyType: row.journey_type,
      source: "live"
    };
  }

  function allEvents() {
    return [...state.liveEvents, ...state.demoEvents];
  }

  function isGap(event) {
    return event.outcome === "gap" || event.outcome === "friction";
  }

  function filteredEvents() {
    const period = $("#filter-period").value;
    const category = $("#filter-category").value;
    const time = $("#filter-time").value;
    const area = $("#filter-area").value;
    const cutoff = period === "all" ? null : Date.now() - Number(period) * 86400000;
    return allEvents().filter((event) => {
      if (cutoff && new Date(event.createdAt).getTime() < cutoff) return false;
      if (category !== "all" && event.category !== category) return false;
      if (area !== "all" && event.originArea !== area) return false;
      if (time === "morning" && (event.hourBucket < 12 || event.hourBucket > 21)) return false;
      if (time === "midday" && (event.hourBucket < 22 || event.hourBucket > 27)) return false;
      if (time === "afternoon" && (event.hourBucket < 28 || event.hourBucket > 37)) return false;
      return true;
    });
  }

  function bucketLabel(bucket) {
    const hour = Math.floor(bucket / 2);
    const minute = bucket % 2 ? "30" : "00";
    return `${String(hour).padStart(2, "0")}:${minute}`;
  }

  function modeLabel(outcome) {
    if (outcome === "served") return "定時便あり";
    if (outcome === "reservation") return "予約交通あり";
    if (outcome === "friction") return "手続きに課題";
    return "移動手段なし";
  }

  async function fetchLiveEvents({ quiet = false } = {}) {
    const refreshButton = $("#refresh-data");
    if (!quiet) refreshButton.disabled = true;
    try {
      const response = await fetch("./api/demand-events?limit=300", { cache: "no-store" });
      if (!response.ok) throw new Error("demand API unavailable");
      const payload = await response.json();
      state.liveEvents = (payload.events || []).map(normalizeLiveEvent);
      state.persistence = Boolean(payload.persistence);
      $("#connection-label").textContent = state.persistence
        ? `匿名需要DB 接続済み・LIVE ${state.liveEvents.length}件`
        : "展示データで表示中";
      $(".dash-status").classList.toggle("connected", state.persistence);
    } catch (_) {
      state.persistence = false;
      $("#connection-label").textContent = "展示データで表示中・公開後LIVE接続";
      $(".dash-status").classList.remove("connected");
    } finally {
      if (!quiet) refreshButton.disabled = false;
      renderDashboard();
    }
  }

  function countBy(items, keyFn) {
    const counts = new Map();
    items.forEach((item) => {
      const key = keyFn(item);
      counts.set(key, (counts.get(key) || 0) + 1);
    });
    return [...counts.entries()].sort((a, b) => b[1] - a[1]);
  }

  function renderKpis(events) {
    const gaps = events.filter(isGap);
    const rate = events.length ? Math.round(gaps.length / events.length * 100) : 0;
    const topDestination = countBy(gaps, (event) => event.destinationName)[0];
    const topHour = countBy(gaps, (event) => event.hourBucket)[0];
    $("#kpi-total").textContent = events.length.toLocaleString("ja-JP");
    $("#kpi-gap-rate").textContent = `${rate}%`;
    $("#kpi-gap-count").textContent = `${gaps.length}件が移動未充足・手続き障壁`;
    $("#kpi-destination").textContent = topDestination ? topDestination[0] : "—";
    $("#kpi-peak").textContent = topHour ? bucketLabel(Number(topHour[0])) : "—";
  }

  function renderFeed(events) {
    const recent = [...events].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)).slice(0, 9);
    $("#event-feed").innerHTML = recent.length ? recent.map((event) => `
      <li>
        <time>${bucketLabel(event.hourBucket)}</time>
        <span><b>${escapeHtml(event.originArea)} → ${escapeHtml(event.destinationName)}</b><small>${CATEGORY_LABELS[event.category] || "移動"}・${modeLabel(event.outcome)}</small></span>
        <em class="${event.source === "live" ? "live" : ""}">${event.source === "live" ? "LIVE" : "DEMO"}</em>
      </li>
    `).join("") : '<li class="feed-loading">選択条件に該当する需要はありません。</li>';
  }

  function renderReasons(events) {
    const gaps = events.filter(isGap);
    const counts = countBy(gaps, (event) => event.reason).slice(0, 5);
    const max = counts[0]?.[1] || 1;
    $("#reason-bars").innerHTML = counts.length ? counts.map(([reason, count]) => `
      <div class="reason-row"><span>${escapeHtml(REASON_LABELS[reason] || REASON_LABELS.unknown)}</span><b>${count}件</b><div><i style="width:${Math.round(count / max * 100)}%"></i></div></div>
    `).join("") : '<div class="reason-row"><span>未充足需要はありません</span><b>0件</b><div><i style="width:0"></i></div></div>';
  }

  function geometryPoints(geometry) {
    if (geometry.type === "Polygon") return geometry.coordinates.flat();
    if (geometry.type === "MultiPolygon") return geometry.coordinates.flat(2);
    return [];
  }

  function polygonPath(geometry, project) {
    const rings = geometry.type === "Polygon" ? geometry.coordinates : geometry.coordinates.flat();
    return rings.map((ring) => ring.map(([lon, lat], index) => {
      const [x, y] = project(lon, lat);
      return `${index ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`;
    }).join(" ") + " Z").join(" ");
  }

  async function loadMapAndScenarios() {
    try {
      const [mapResponse, scenariosResponse] = await Promise.all([
        fetch("./towns.geojson"), fetch("./wagon-scenarios.json", { cache: "no-store" })
      ]);
      if (!mapResponse.ok || !scenariosResponse.ok) throw new Error("map resources unavailable");
      const [geo, scenarioData] = await Promise.all([mapResponse.json(), scenariosResponse.json()]);
      state.scenarios = scenarioData.scenarios || [];
      const points = geo.features.flatMap((feature) => geometryPoints(feature.geometry));
      const lons = points.map((point) => point[0]);
      const lats = points.map((point) => point[1]);
      const minLon = Math.min(...lons), maxLon = Math.max(...lons);
      const minLat = Math.min(...lats), maxLat = Math.max(...lats);
      const scale = Math.min(650 / (maxLon - minLon), 690 / (maxLat - minLat));
      const offsetX = (720 - (maxLon - minLon) * scale) / 2;
      const offsetY = (760 - (maxLat - minLat) * scale) / 2;
      state.project = (lon, lat) => [offsetX + (lon - minLon) * scale, offsetY + (maxLat - lat) * scale];
      const fragment = document.createDocumentFragment();
      geo.features.forEach((feature) => {
        const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
        path.setAttribute("d", polygonPath(feature.geometry, state.project));
        path.classList.add("town-shape");
        fragment.appendChild(path);
      });
      $("#demand-map").appendChild(fragment);
      $("#map-loading").hidden = true;
      renderDashboard();
    } catch (error) {
      $("#map-loading").textContent = "地図データを読み込めませんでした。";
      console.error(error);
    }
  }

  function showMapTooltip(event) {
    const node = event.currentTarget;
    const tip = $("#map-tooltip");
    tip.innerHTML = `<b>${escapeHtml(node.dataset.area)}</b><span>匿名検索 ${node.dataset.total}件</span><span>移動可能 ${node.dataset.served}件</span><strong>未充足・障壁 ${node.dataset.gap}件</strong>`;
    tip.hidden = false;
    const wrap = $("#demand-map-wrap").getBoundingClientRect();
    const source = event.touches?.[0] || event;
    if (source.clientX != null) {
      tip.style.left = `${Math.min(source.clientX - wrap.left + 14, wrap.width - 220)}px`;
      tip.style.top = `${Math.max(source.clientY - wrap.top - 40, 8)}px`;
    }
  }

  function hideMapTooltip() {
    $("#map-tooltip").hidden = true;
  }

  function renderMap(events) {
    if (!state.project) return;
    $$(".demand-node").forEach((node) => node.remove());
    const summaries = new Map();
    Object.keys(AREA_POINTS).forEach((area) => summaries.set(area, { total: 0, gap: 0, served: 0 }));
    events.forEach((event) => {
      if (!summaries.has(event.originArea)) return;
      const item = summaries.get(event.originArea);
      item.total += 1;
      if (isGap(event)) item.gap += 1; else item.served += 1;
    });
    const maxGap = Math.max(1, ...[...summaries.values()].map((item) => item.gap));
    const namespace = "http://www.w3.org/2000/svg";
    summaries.forEach((summary, area) => {
      if (!summary.total) return;
      const point = AREA_POINTS[area];
      const [x, y] = state.project(point[0], point[1]);
      const radius = 7 + Math.sqrt(summary.gap / maxGap) * 18;
      const group = document.createElementNS(namespace, "g");
      group.classList.add("demand-node");
      group.setAttribute("tabindex", "0");
      group.setAttribute("role", "button");
      group.setAttribute("aria-label", `${area}、匿名検索${summary.total}件、未充足${summary.gap}件`);
      Object.assign(group.dataset, { area, total: summary.total, gap: summary.gap, served: summary.served });
      const halo = document.createElementNS(namespace, "circle");
      halo.setAttribute("cx", x); halo.setAttribute("cy", y); halo.setAttribute("r", radius + 8); halo.classList.add("node-halo");
      const served = document.createElementNS(namespace, "circle");
      served.setAttribute("cx", x); served.setAttribute("cy", y); served.setAttribute("r", Math.max(3, Math.sqrt(summary.served) * 1.6)); served.classList.add("served-core");
      const core = document.createElementNS(namespace, "circle");
      core.setAttribute("cx", x); core.setAttribute("cy", y); core.setAttribute("r", radius); core.classList.add("node-core");
      const label = document.createElementNS(namespace, "text");
      label.setAttribute("x", x); label.setAttribute("y", y - radius - 8); label.setAttribute("text-anchor", "middle"); label.textContent = area;
      group.append(halo, core, served, label);
      group.addEventListener("pointerenter", showMapTooltip);
      group.addEventListener("pointermove", showMapTooltip);
      group.addEventListener("pointerleave", hideMapTooltip);
      group.addEventListener("focus", showMapTooltip);
      group.addEventListener("blur", hideMapTooltip);
      group.addEventListener("click", () => {
        $("#filter-area").value = area;
        renderDashboard();
      });
      $("#demand-map").appendChild(group);
    });
  }

  function drawOptimizerRoutes(scenarios) {
    $$(".optimizer-route").forEach((node) => node.remove());
    if (!state.project) return;
    const namespace = "http://www.w3.org/2000/svg";
    scenarios.forEach((scenario, index) => {
      const path = document.createElementNS(namespace, "path");
      const data = scenario.routeCoordinates.map(([lon, lat], pointIndex) => {
        const [x, y] = state.project(lon, lat);
        return `${pointIndex ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`;
      }).join(" ");
      path.setAttribute("d", data);
      path.setAttribute("fill", "none");
      path.setAttribute("stroke", index === 0 ? "#60f2b2" : "#62d8ff");
      path.setAttribute("stroke-width", index === 0 ? "5" : "3");
      path.setAttribute("stroke-linecap", "round");
      path.setAttribute("stroke-linejoin", "round");
      path.setAttribute("stroke-dasharray", index === 0 ? "0" : "7 6");
      path.classList.add("optimizer-route");
      $("#demand-map").appendChild(path);
    });
  }

  function calculateOptimization(events) {
    if (!state.scenarios.length) return null;
    const vehicles = Number($("#vehicles").value);
    const trips = Number($("#trips").value);
    const walk = Number($("#walk").value);
    const priority = $("#priority").value;
    const gaps = events.filter(isGap);
    const ranked = state.scenarios.map((scenario) => {
      const area = SCENARIO_AREAS[scenario.id];
      const areaGaps = gaps.filter((event) => event.originArea === area);
      const priorityGaps = priority === "all" ? [] : areaGaps.filter((event) => event.category === priority);
      const score = scenario.recoveredElderly + areaGaps.length * 32 + priorityGaps.length * 48;
      return { ...scenario, area, areaGaps: areaGaps.length, priorityGaps: priorityGaps.length, score };
    }).sort((a, b) => b.score - a.score);
    const selected = ranked.slice(0, vehicles);
    const tripFactor = Math.min(1.45, .7 + trips * .1);
    const walkFactor = Math.min(1.28, 1 + (walk - 300) / 1800);
    const rawRecovery = selected.reduce((total, scenario, index) => total + scenario.recoveredElderly * (index ? .82 : 1), 0);
    const recoveredElderly = Math.min(2227, Math.round(rawRecovery * tripFactor * walkFactor));
    const selectedAreas = new Set(selected.map((scenario) => scenario.area));
    const selectedGaps = gaps.filter((event) => selectedAreas.has(event.originArea));
    const recoveryRate = Math.min(.92, .22 + trips * .085 + (walk - 300) / 2600);
    const improvedDemand = Math.round(selectedGaps.length * recoveryRate);
    return { ranked, selected, recoveredElderly, improvedDemand, vehicles, trips, walk, priority };
  }

  function renderOptimizer(events) {
    const result = calculateOptimization(events);
    if (!result) return;
    state.selectedScenarios = result.selected;
    const first = result.selected[0];
    $("#recommendation-title").textContent = result.selected.length === 1
      ? first.name : result.selected.map((scenario) => scenario.shortName).join(" ＋ ");
    $("#confidence-label").textContent = result.priority === "all" ? "DATA BEST" : `${CATEGORY_LABELS[result.priority]} PRIORITY`;
    $("#scenario-ranking").innerHTML = result.ranked.map((scenario, index) => `
      <article class="scenario-card ${index < result.vehicles ? "selected" : ""}">
        <span>0${index + 1} / ${escapeHtml(scenario.area)}</span>
        <b>${escapeHtml(scenario.shortName)}</b>
        <small>未充足 ${scenario.areaGaps}件・徒歩圏 +${scenario.recoveredElderly}人</small>
        <strong>${Math.round(scenario.score).toLocaleString("ja-JP")}</strong>
      </article>
    `).join("");
    $("#result-elderly").textContent = `${result.recoveredElderly.toLocaleString("ja-JP")}人`;
    $("#result-demand").textContent = `${result.improvedDemand}件`;
    $("#result-areas").textContent = `${result.selected.length}地区`;
    const purpose = result.priority === "all" ? "全生活目的" : CATEGORY_LABELS[result.priority];
    $("#decision-copy").textContent = `${purpose}を評価し、${result.selected.map((scenario) => scenario.area).join("・")}の未充足需要と既存徒歩圏の空白を同時に最大化。追加${result.vehicles}台・平日${result.trips}往復・徒歩${result.walk}mの条件で比較しました。`;
    drawOptimizerRoutes(result.selected);
  }

  function renderDashboard() {
    const events = filteredEvents();
    renderKpis(events);
    renderFeed(events);
    renderReasons(events);
    renderMap(events);
    renderOptimizer(events);
  }

  function setupControls() {
    Object.keys(AREA_POINTS).filter((area) => area !== "位置情報周辺").forEach((area) => {
      const option = document.createElement("option");
      option.value = area;
      option.textContent = area;
      $("#filter-area").appendChild(option);
    });
    ["#filter-period", "#filter-category", "#filter-time", "#filter-area"].forEach((selector) => {
      $(selector).addEventListener("change", renderDashboard);
    });
    $("#reset-map").addEventListener("click", () => {
      $("#filter-area").value = "all";
      renderDashboard();
    });
    $("#refresh-data").addEventListener("click", () => fetchLiveEvents());

    const rangeControls = [
      ["#vehicles", "#vehicles-output", (value) => `${value}台`],
      ["#trips", "#trips-output", (value) => `${value}往復`],
      ["#walk", "#walk-output", (value) => `${value}m`]
    ];
    rangeControls.forEach(([inputSelector, outputSelector, formatter]) => {
      $(inputSelector).addEventListener("input", () => {
        $(outputSelector).textContent = formatter($(inputSelector).value);
        renderOptimizer(filteredEvents());
      });
    });
    $("#priority").addEventListener("change", () => renderOptimizer(filteredEvents()));
    $("#optimizer-form").addEventListener("submit", (event) => {
      event.preventDefault();
      const button = $("#run-optimizer");
      button.classList.add("is-running");
      button.innerHTML = "<span>CALCULATING</span>時空間需要を再集計中…";
      setTimeout(() => {
        renderOptimizer(filteredEvents());
        button.classList.remove("is-running");
        button.innerHTML = "<span>OPTIMIZED</span>この条件で再計算しました";
        $(".optimizer-result").scrollIntoView({ behavior: "smooth", block: "center" });
      }, 720);
    });
    $$(".official-grid article[data-current]").forEach((card) => {
      const current = Number(card.dataset.current);
      const target = Number(card.dataset.target);
      card.querySelector("div i").style.width = `${Math.min(100, current / target * 100)}%`;
    });
  }

  state.demoEvents = createDemoEvents();
  setupControls();
  loadMapAndScenarios();
  fetchLiveEvents();
  setInterval(() => fetchLiveEvents({ quiet: true }), 15000);
})();
