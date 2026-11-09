/* PC-Mem 静态预录演示 · 前端脚本
 * 数据来自 snapshot.js（window.PCMEM_SNAPSHOT）；不发起任何网络请求，不调用模型，不需要 API Key。
 * 图谱画布、节点/边卡片、资料树、时间线、社区视图沿用 pc-mem 演示的绘制逻辑。 */
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const TYPE_COLORS = {
    Person: '#0284c7', Organization: '#7c3aed', Project: '#d97706',
    Document: '#64748b', Event: '#e11d48', Topic: '#059669',
    Artifact: '#db2777', Technology: '#2563eb', Place: '#9333ea',
    TimePeriod: '#a16207', Metric: '#0d9488', Decision: '#dc2626',
  };
  const TYPE_ZH = {
    Person: '人物', Organization: '组织', Project: '项目', Document: '文档',
    Event: '事件', Topic: '主题', Artifact: '产物', Technology: '技术',
    Place: '地点', TimePeriod: '时期', Metric: '指标', Decision: '决定',
  };
  const REL_ZH = {
    AUTHORED_BY: '撰写', MENTIONS: '提及', PART_OF: '属于', PRODUCES: '产出',
    USES: '使用', PRECEDES: '先于', SUPERSEDES: '取代', RELATES_TO: '相关',
    LOCATED_IN: '位于', HAS_METRIC: '指标为', DECIDED_IN: '决定发生于',
  };
  const STAGE_ZH = {
    vector: '向量', keyword: '关键词', graph: '图谱', community: '社区',
    hyde: 'HyDE', rerank: '精排', scope: '权限',
  };
  const FOLDER_ORDER = ['远山项目', '河图项目', '会议', '个人'];

  const SNAPSHOT = window.PCMEM_SNAPSHOT || {};
  const META = SNAPSHOT.meta || {};
  const PLAYBACK = META.playback || {};
  const EXAMPLES = [PLAYBACK.question || '远山项目的预算总额是多少？'];

  const state = {
    counts: {},
    projects: [],
    documents: [],
    chains: [],
    graph: { nodes: [], links: [], communities: [], ontology: { entity_types: [] } },
    lastBuild: null,
    view: 'graph',
    projectFilterId: '',
    hiddenTypes: new Set(),
    selectedNode: null,
    selectedEdge: null,
    evidenceChunkIds: new Set(),
    evidenceEntityIds: new Set(),
    searchTerm: '',
    showSuperseded: false,
    documentId: null,
    graphEngine: null,
    playback: { token: 0, running: false },
  };

  // ---------- tiny DOM helpers ----------
  function h(tag, props = {}, ...children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(props || {})) {
      if (value === null || value === undefined || value === false) continue;
      if (key === 'class') node.className = value;
      else if (key === 'text') node.textContent = value;
      else if (key === 'dataset') Object.assign(node.dataset, value);
      else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2).toLowerCase(), value);
      else if (key === 'value') node.value = value;
      else if (key === 'checked') node.checked = Boolean(value);
      else node.setAttribute(key, value === true ? '' : value);
    }
    for (const child of children.flat(3)) {
      if (child === null || child === undefined || child === false) continue;
      node.append(child instanceof Node ? child : document.createTextNode(String(child)));
    }
    return node;
  }

  function clear(node) { if (node) node.replaceChildren(); }
  function fmt(n) { return Number(n || 0).toLocaleString('zh-CN'); }
  function dateText(value) { return value || '—'; }
  function relationColor(type) {
    if (['PRECEDES', 'SUPERSEDES', 'DECIDED_IN'].includes(type)) return '#6d28d9';
    if (type === 'HAS_METRIC') return '#0f766e';
    if (['AUTHORED_BY', 'PART_OF', 'PRODUCES', 'USES'].includes(type)) return '#2563eb';
    return '#64748b';
  }

  function projectColor(name) {
    if (name === '远山') return '#2563eb';
    if (name === '河图') return '#b45309';
    const palette = ['#0f766e', '#7c3aed', '#db2777', '#a16207', '#15803d'];
    let hash = 0;
    for (const ch of String(name || '')) hash = (hash * 31 + ch.codePointAt(0)) | 0;
    return palette[Math.abs(hash) % palette.length];
  }
  function typeColor(type) {
    if (TYPE_COLORS[type]) return TYPE_COLORS[type];
    let hash = 0;
    for (const ch of String(type || '')) hash = (hash * 17 + ch.codePointAt(0)) | 0;
    const palette = ['#0f766e', '#2563eb', '#be185d', '#a16207', '#6d28d9'];
    return palette[Math.abs(hash) % palette.length];
  }
  function licenseLabel(value) {
    return ({ public: 'public', open_commercial: 'open', restricted: '受限', unknown: '未知' })[value] || value || '未知';
  }
  function projectSourceLabel(value) {
    return ({ manual: '人工', rule: '规则', inferred: '模型推断' })[value] || '未归属';
  }
  function formatBadge(format) { return String(format || 'file').toUpperCase(); }

  function toast(message, bad = false) {
    const node = $('toast');
    node.textContent = message;
    node.classList.toggle('bad', bad);
    node.classList.add('show');
    clearTimeout(toast._timer);
    toast._timer = setTimeout(() => node.classList.remove('show'), 3200);
  }


  // ---------- snapshot data (no network) ----------
  function loadSnapshot() {
    const snapshotState = SNAPSHOT.state || {};
    const snapshotDocs = SNAPSHOT.documents || {};
    state.counts = snapshotState.counts || {};
    state.projects = snapshotState.projects || [];
    state.documents = snapshotDocs.documents || [];
    state.chains = snapshotDocs.version_chains || [];
    state.graph = SNAPSHOT.graph || state.graph;
    state.lastBuild = snapshotState.build || null;
  }

  function renderStatus() {
    const counts = state.counts || {};
    $('status').className = 'status static';
    $('statusText').textContent =
      `静态快照 · ${fmt(counts.documents)} 文件 / ${fmt(counts.versions)} 修订 · ` +
      `${fmt(counts.entities)} 实体 / ${fmt(counts.relationships)} 关系 · ${fmt(counts.communities)} 社区`;
  }

  // Paragraph text is not part of the snapshot; graph extraction keeps the quote
  // for every (chunk, entity) mention, so cards show those quotes instead.
  function snapshotEvidence(chunkIds) {
    const wanted = new Set(chunkIds || []);
    const items = [];
    const seen = new Set();
    if (!wanted.size) return { items };
    for (const link of state.graph.links || []) {
      if (!link.chunk_id || !wanted.has(link.chunk_id) || !link.evidence) continue;
      const key = `${link.chunk_id}|${link.evidence}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const doc = (state.documents || []).find((item) => item.id === link.document_id);
      items.push({
        id: link.chunk_id,
        content: link.evidence,
        document_id: link.document_id,
        title: doc?.title || '来源文档',
        version_seq: doc?.version_seq ?? 1,
        section_path: '图谱快照片段',
      });
    }
    return { items };
  }

  function renderSnapshotInfo() {
    const body = $('snapshotBody');
    clear(body);
    const counts = state.counts || {};
    const rows = [
      ['快照抓取时间', META.captured_at || '—'],
      ['数据来源', META.source || '—'],
      ['取数接口', (META.endpoints || []).join(' · ') || '—'],
      ['最近一次真实构建', (META.build_finished_at || '—').replace('T', ' ')],
      ['快照规模', `${fmt(counts.documents)} 文件 · ${fmt(counts.versions)} 修订 · ${fmt(counts.chunks)} 段落 · ` +
        `${fmt(counts.entities)} 实体 · ${fmt(counts.relationships)} 关系 · ${fmt(counts.communities)} 社区`],
    ];
    for (const [label, value] of rows) {
      body.append(h('div', { class: 'snap-row' }, h('span', {}, label), h('strong', {}, value)));
    }
    body.append(h('div', { class: 'snap-note' },
      '这份页面是本机演示服务的只读快照：重建、模型设置、连接测试、实时检索全部关闭。' +
      '问答区里的「播放预录演示」是一段写死的脚本，阶段、候选数、耗时、答案与引用都来自事先录制；' +
      '播放过程中页面不会发起任何网络请求，也没有 API Key。'));
  }

  // ---------- project controls ----------
  function renderProjectSelect() {
    const select = $('projectFilter');
    const current = state.projectFilterId;
    clear(select);
    select.append(h('option', { value: '' }, '全部项目'));
    for (const project of state.projects) {
      select.append(h('option', { value: project.id }, project.name));
    }
    select.value = current && state.projects.some((p) => p.id === current) ? current : '';
    if (!select.value) state.projectFilterId = '';
  }

  function renderProjectChips() {
    const box = $('projectChips');
    clear(box);
    const make = (id, name, color) => h('button', {
      class: 'project-chip' + (state.projectFilterId === id ? ' active' : ''),
      onclick: () => {
        state.projectFilterId = state.projectFilterId === id ? '' : id;
        $('projectFilter').value = state.projectFilterId;
        renderProjectChips();
        drawGraph();
      },
    }, h('span', { class: 'dot', style: `background:${color}` }), name);
    box.append(make('', '全部', '#8b95a9'));
    for (const project of state.projects) box.append(make(project.id, project.name, projectColor(project.name)));
  }

  // ---------- document tree ----------
  function renderDocTree() {
    const tree = $('docTree');
    clear(tree);
    $('docCount').textContent = String(state.counts.documents || 0);
    const visible = state.documents.filter((doc) => doc.is_current || state.showSuperseded);
    if (!visible.length) {
      tree.append(h('div', { class: 'loading' }, '快照里还没有资料。'));
      return;
    }
    const groups = new Map();
    for (const doc of visible) {
      const parts = String(doc.path || '').split('/').filter(Boolean);
      const folder = parts.length > 1 ? parts[0] : '根目录';
      if (!groups.has(folder)) groups.set(folder, []);
      groups.get(folder).push(doc);
    }
    const folders = [...groups.keys()].sort((a, b) => {
      const ai = FOLDER_ORDER.indexOf(a), bi = FOLDER_ORDER.indexOf(b);
      if (ai !== -1 || bi !== -1) return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
      return a.localeCompare(b, 'zh-CN');
    });
    for (const folder of folders) {
      const docs = groups.get(folder).sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')) || a.title.localeCompare(b.title, 'zh-CN'));
      const currentDocs = docs.filter((doc) => doc.is_current);
      const body = h('div');
      for (const doc of currentDocs) body.append(docRow(doc));
      const details = h('details', { class: 'doc-folder', open: true }, h('summary', {},
        h('span', { class: 'chev' }, '▶'),
        h('span', { class: 'folder-name' }, folder),
        h('span', { class: 'count-pill' }, String(currentDocs.length)),
      ), body);
      // Folders the user has interacted with keep their state.
      if (docTreeState.has(folder)) details.open = docTreeState.get(folder);
      details.addEventListener('toggle', () => docTreeState.set(folder, details.open));
      tree.append(details);
    }
  }

  const docTreeState = new Map();

  function docRow(doc) {
    const chain = state.chains.find((item) => item.identity_key === doc.identity_key);
    const selected = state.documentId === doc.id;
    const row = h('div', {
      class: 'doc-row' + (selected ? ' selected' : '') + (doc.is_current ? '' : ' stale'),
      title: doc.path,
      onclick: () => selectDocument(doc.id),
    },
      h('span', { class: `format-badge ${doc.format}` }, formatBadge(doc.format)),
      h('div', { class: 'doc-main' },
        h('div', { class: 'doc-title' }, doc.title),
        h('div', { class: 'doc-sub' },
          doc.project ? h('span', { class: 'pdot', style: `background:${projectColor(doc.project.name)}` }) : null,
          doc.project ? h('span', {}, doc.project.name) : h('span', { class: 'muted' }, projectSourceLabel(doc.project_source)),
          h('span', {}, dateText(doc.date)),
          doc.version_seq > 1 ? h('span', { class: 'vbadge' }, `修订 ${doc.version_seq}`) : null,
          !doc.is_current ? h('span', { class: 'lock' }, '· 失效') : null,
          doc.license === 'restricted' ? h('span', { class: 'lock', title: '受限资料：默认不参与外发' }, '🔒') : null,
        ),
      ),
    );
    if (!chain || chain.revisions.length < 2) return row;
    const wrap = h('div');
    wrap.append(row);
    if (state.showSuperseded) {
      const list = h('div', { class: 'chain-list' });
      for (const rev of chain.revisions) {
        list.append(h('div', {
          class: 'doc-row' + (rev.is_current ? '' : ' stale'),
          title: `修订 ${rev.version_seq} · ${rev.date || ''}`,
          onclick: (event) => { event.stopPropagation(); selectDocument(rev.id); },
        }, h('span', { class: 'format-badge' }, `修${rev.version_seq}`),
           h('div', { class: 'doc-main' }, h('div', { class: 'doc-title' }, rev.title),
             h('div', { class: 'doc-sub' }, rev.is_current ? '当前版本' : '已失效 · 不参与检索', '·', dateText(rev.date)))),
        );
      }
      wrap.append(list);
    }
    return wrap;
  }

  // ---------- timeline ----------
  function chainFor(doc) {
    return state.chains.find((chain) => chain.identity_key === doc.identity_key);
  }

  function renderTimeline() {
    const box = $('timelineView');
    clear(box);
    const docs = state.documents.filter((doc) => doc.is_current)
      .sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
    box.append(h('p', { class: 'timeline-intro' },
      `这是文件空间的“工作历史”：${docs.length} 个当前文档按日期排列。同一路径的修订合成一条版本链，只有最末一条进入检索。修订序号按入库顺序编号；标题里的 v1/v2 是文件自称的版本名。`,
      h('br'), '点击卡片查看正文段落、修订链与引用关系。'));
    if (!docs.length) {
      box.append(h('div', { class: 'loading' }, '还没有文档。'));
      return;
    }
    for (const doc of docs) {
      const chain = chainFor(doc);
      const card = h('div', { class: 'timeline-card', onclick: () => selectDocument(doc.id) },
        h('h4', {}, doc.title),
        h('div', { class: 'meta' },
          doc.project ? h('span', { style: `color:${projectColor(doc.project.name)}` }, `● ${doc.project.name}`) : h('span', {}, projectSourceLabel(doc.project_source)),
          h('span', {}, formatBadge(doc.format)),
          h('span', { class: `license-tag ${doc.license}` }, licenseLabel(doc.license)),
          h('span', {}, doc.path),
        ),
      );
      if (chain && chain.revisions.length > 1) {
        const strip = h('div', { class: 'version-strip' });
        for (const rev of chain.revisions) {
          strip.append(h('button', {
            class: 'version-chip' + (rev.is_current ? ' current' : ' stale'),
            title: rev.is_current ? '当前版本' : '已失效版本',
            onclick: (event) => { event.stopPropagation(); selectDocument(rev.id); },
          }, `修订 ${rev.version_seq} · ${dateText(rev.date)}`));
        }
        card.append(strip);
      }
      if (doc.citations_out?.length) {
        const cites = h('div', { class: 'cites' }, h('span', {}, '引用：'));
        for (const cite of doc.citations_out.slice(0, 6)) {
          cites.append(h('span', { class: 'cite-chip', title: cite.key || '' }, cite.title || cite.key));
        }
        card.append(cites);
      }
      const item = h('div', { class: 'timeline-item' },
        h('div', { class: 'timeline-date' }, dateText(doc.date)),
        h('div', { class: 'timeline-line' }, card));
      box.append(item);
    }
  }

  // ---------- communities ----------
  function renderCommunities() {
    const box = $('communitiesView');
    clear(box);
    const communities = state.graph.communities || [];
    box.append(h('p', { class: 'communities-intro' },
      `社区摘要是对图谱里联系紧密的一组实体做的聚合描述（${communities.length} 个）。回答路径在带权限或排除过滤时会主动关闭这一层，避免聚合文本越过范围约束。`));
    if (!communities.length) {
      box.append(h('div', { class: 'loading' }, '还没有社区摘要。重建图谱时勾选「生成社区摘要」，或用 CLI 的 --with-communities。'));
      return;
    }
    const grid = h('div', { class: 'community-grid' });
    const nodeById = new Map((state.graph.nodes || []).map((node) => [node.id, node]));
    for (const community of communities) {
      const members = (community.member_ids || []).map((id) => nodeById.get(id)).filter(Boolean);
      const card = h('div', { class: 'community-card' },
        h('h4', {}, community.title || '社区'),
        h('p', {}, community.summary || '（没有摘要）'),
        h('div', { class: 'member-chips' },
          ...members.slice(0, 12).map((node) => h('button', {
            class: 'member-chip',
            onclick: () => selectNode(node.id),
            title: `${TYPE_ZH[node.type] || node.type}`,
          }, node.name))),
      );
      grid.append(card);
    }
    box.append(grid);
  }

  // ---------- graph ----------
  function initGraph() {
    const canvas = $('graphCanvas');
    const engine = state.graphEngine || createGraphEngine(canvas);
    state.graphEngine = engine;
    engine.setData(state.graph);
    // Pre-settle the layout so the first paint is already readable on a projector.
    engine.warm(220);
    $('graphEmpty').hidden = Boolean((state.graph.nodes || []).length);
    engine.draw();
  }

  function createGraphEngine(canvas) {
    const ctx = canvas.getContext('2d');
    const engine = {
      canvas, ctx, nodes: [], links: [], nodeById: new Map(),
      pan: { x: 0, y: 0 }, zoom: 1, alpha: 1, running: false, raf: 0,
      selected: null, selectedEdge: null, hover: null, hoverEdge: null,
      dragging: null, panning: null, edgePress: null, moved: false,
      userInteracted: false, fitted: false, width: 1, height: 1, dpr: 1,
    };

    function resize() {
      const rect = canvas.getBoundingClientRect();
      engine.width = Math.max(1, rect.width);
      engine.height = Math.max(1, rect.height);
      engine.dpr = Math.min(2.5, window.devicePixelRatio || 1);
      canvas.width = Math.round(engine.width * engine.dpr);
      canvas.height = Math.round(engine.height * engine.dpr);
      ctx.setTransform(engine.dpr, 0, 0, engine.dpr, 0, 0);
      // Keep the view framed until the user pans/zooms, so a resolution change
      // does not leave the graph half off-canvas.
      if (engine.nodes.length && (!engine.fitted || !engine.userInteracted)) fit();
      draw();
    }

    function typeAnchor(type) {
      const all = (state.graph.nodes && state.graph.nodes.length) ? state.graph.nodes : engine.nodes;
      const types = [...new Set(all.map((node) => node.type))].sort();
      const index = Math.max(0, types.indexOf(type));
      const angle = (index / Math.max(1, types.length)) * Math.PI * 2 - Math.PI / 2;
      const radius = Math.min(330, 90 + Math.sqrt(Math.max(1, all.length)) * 20);
      return { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius };
    }

    function setData(data) {
      const previous = new Map(engine.nodes.map((node) => [node.id, node]));
      const nodes = (data.nodes || []).map((node) => {
        const old = previous.get(node.id);
        const anchor = typeAnchor(node.type);
        let hash = 0;
        for (const ch of node.id) hash = (hash * 33 + ch.codePointAt(0)) | 0;
        const jitter = () => ((Math.abs(hash) % 1000) / 1000 - 0.5) * 130;
        return {
          ...node,
          x: old ? old.x : anchor.x + jitter(),
          y: old ? old.y : anchor.y + jitter() * 0.9,
          vx: 0, vy: 0,
          r: 5 + Math.min(13, Math.sqrt(node.degree || 0) * 2.1),
        };
      });
      engine.nodes = nodes;
      engine.nodeById = new Map(nodes.map((node) => [node.id, node]));
      engine.links = (data.links || []).filter((link) => engine.nodeById.has(link.source) && engine.nodeById.has(link.target));
      engine.selected = state.selectedNode && engine.nodeById.has(state.selectedNode) ? state.selectedNode : null;
      engine.selectedEdge = state.selectedEdge && engine.links.some((link) => link.id === state.selectedEdge)
        ? state.selectedEdge : null;
      engine.alpha = 1;
      engine.fitted = engine.fitted && previous.size > 0;
      if (!engine.running) { engine.running = true; requestAnimationFrame(loop); }
      resize();
    }

    function visible(node) {
      if (state.hiddenTypes.has(node.type)) return false;
      if (state.searchTerm) {
        const term = state.searchTerm.toLowerCase();
        if (!String(node.name).toLowerCase().includes(term) && !(node.aliases || []).some((alias) => String(alias).toLowerCase().includes(term))) return false;
      }
      return true;
    }

    function focusWeight(node) {
      let weight = 1;
      const projectName = state.projects.find((project) => project.id === state.projectFilterId)?.name;
      if (projectName && node.project !== projectName) weight *= 0.08;
      if (state.evidenceEntityIds.size) weight *= state.evidenceEntityIds.has(node.id) ? 1 : 0.22;
      if (state.searchTerm) {
        const term = state.searchTerm.toLowerCase();
        const matched = String(node.name).toLowerCase().includes(term) || (node.aliases || []).some((alias) => String(alias).toLowerCase().includes(term));
        if (!matched) weight *= 0.16;
      }
      return weight;
    }

    function tick() {
      const nodes = engine.nodes;
      const alpha = engine.alpha;
      for (let i = 0; i < nodes.length; i += 1) {
        const a = nodes[i];
        for (let j = i + 1; j < nodes.length; j += 1) {
          const b = nodes[j];
          let dx = b.x - a.x;
          let dy = b.y - a.y;
          let d2 = dx * dx + dy * dy;
          if (d2 < 1) { dx = 0.6; dy = 0.6; d2 = 0.72; }
          if (d2 > 250000) continue;
          const force = (1250 / d2) * alpha;
          const d = Math.sqrt(d2);
          const fx = (dx / d) * force;
          const fy = (dy / d) * force;
          a.vx -= fx; a.vy -= fy;
          b.vx += fx; b.vy += fy;
        }
      }
      for (const link of engine.links) {
        const a = engine.nodeById.get(link.source);
        const b = engine.nodeById.get(link.target);
        if (!a || !b) continue;
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const dist = Math.sqrt(dx * dx + dy * dy) || 1;
        const target = 64;
        const force = (dist - target) * 0.012 * alpha;
        const fx = (dx / dist) * force;
        const fy = (dy / dist) * force;
        a.vx += fx; a.vy += fy;
        b.vx -= fx; b.vy -= fy;
      }
      for (const node of nodes) {
        node.vx -= node.x * 0.0016 * alpha;
        node.vy -= node.y * 0.0016 * alpha;
        if (engine.dragging?.node === node) { node.vx = 0; node.vy = 0; continue; }
        node.vx *= 0.88;
        node.vy *= 0.88;
        node.x += Math.max(-12, Math.min(12, node.vx));
        node.y += Math.max(-12, Math.min(12, node.vy));
      }
    }

    function loop() {
      if (!engine.running) return;
      tick();
      draw();
      engine.alpha *= 0.986;
      if (engine.alpha > 0.025 || engine.dragging) {
        engine.raf = requestAnimationFrame(loop);
      } else {
        engine.running = false;
        if (!engine.fitted) { fit(); engine.fitted = true; }
        draw();
      }
    }

    function reheat() {
      engine.alpha = Math.max(engine.alpha, 0.55);
      if (!engine.running) { engine.running = true; requestAnimationFrame(loop); }
    }

    function fit() {
      if (!engine.nodes.length) return;
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const node of engine.nodes) {
        if (!visible(node)) continue;
        minX = Math.min(minX, node.x); minY = Math.min(minY, node.y);
        maxX = Math.max(maxX, node.x); maxY = Math.max(maxY, node.y);
      }
      if (!Number.isFinite(minX)) return;
      const pad = 68;
      const sx = (engine.width - pad * 2) / Math.max(80, maxX - minX);
      const sy = (engine.height - pad * 2) / Math.max(80, maxY - minY);
      engine.zoom = Math.max(0.3, Math.min(1.7, Math.min(sx, sy)));
      engine.pan.x = engine.width / 2 - ((minX + maxX) / 2) * engine.zoom;
      engine.pan.y = engine.height / 2 - ((minY + maxY) / 2) * engine.zoom;
    }

    function warm(steps) {
      for (let i = 0; i < steps && engine.alpha > 0.05; i += 1) {
        tick();
        engine.alpha *= 0.986;
      }
      engine.fitted = true;
      fit();
      draw();
    }

    // Frame a subset of nodes (used by the pre-recorded demo when it highlights evidence).
    function frame(ids) {
      const wanted = new Set(ids || []);
      const points = engine.nodes.filter((node) => wanted.has(node.id));
      if (points.length < 2) return;
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const node of points) {
        minX = Math.min(minX, node.x); minY = Math.min(minY, node.y);
        maxX = Math.max(maxX, node.x); maxY = Math.max(maxY, node.y);
      }
      const pad = 124;
      const sx = (engine.width - pad * 2) / Math.max(60, maxX - minX);
      const sy = (engine.height - pad * 2) / Math.max(60, maxY - minY);
      engine.zoom = Math.max(0.9, Math.min(2.6, Math.min(sx, sy)));
      engine.pan.x = engine.width / 2 - ((minX + maxX) / 2) * engine.zoom;
      engine.pan.y = engine.height / 2 - ((minY + maxY) / 2) * engine.zoom;
      engine.userInteracted = true;
      draw();
    }

    function edgeColor(type) {
      if (['PRECEDES', 'SUPERSEDES', 'DECIDED_IN'].includes(type)) return 'rgba(109,40,217,.55)';
      if (type === 'HAS_METRIC') return 'rgba(13,148,136,.60)';
      if (type === 'AUTHORED_BY' || type === 'PART_OF' || type === 'PRODUCES' || type === 'USES') return 'rgba(37,99,235,.52)';
      return 'rgba(100,116,139,.46)';
    }

    function draw() {
      const ctx2 = engine.ctx;
      ctx2.setTransform(engine.dpr, 0, 0, engine.dpr, 0, 0);
      ctx2.clearRect(0, 0, engine.width, engine.height);
      ctx2.save();
      ctx2.translate(engine.pan.x, engine.pan.y);
      ctx2.scale(engine.zoom, engine.zoom);
      const selected = engine.selected;
      const selectedEdge = engine.selectedEdge;
      let selectedLink = null;
      let selectedGeom = null;
      const focusSet = state.evidenceEntityIds;
      const hasFocus = focusSet.size > 0;
      for (const link of engine.links) {
        if (link.id === selectedEdge) { selectedLink = link; continue; }
        const a = engine.nodeById.get(link.source);
        const b = engine.nodeById.get(link.target);
        if (!a || !b || !visible(a) || !visible(b)) continue;
        let weight = 1;
        if (hasFocus) weight = focusSet.has(a.id) && focusSet.has(b.id) ? 1 : 0.12;
        else if (selected) weight = (a.id === selected || b.id === selected) ? 1 : 0.22;
        weight *= Math.min(focusWeight(a), focusWeight(b));
        if (weight <= 0.03) continue;
        ctx2.globalAlpha = Math.max(0.05, weight);
        ctx2.strokeStyle = edgeColor(link.type);
        ctx2.lineWidth = (selected && (a.id === selected || b.id === selected)) || engine.hoverEdge === link.id ? 1.8 : 1.0;
        ctx2.beginPath();
        ctx2.moveTo(a.x, a.y);
        ctx2.lineTo(b.x, b.y);
        ctx2.stroke();
        if (selected && (a.id === selected || b.id === selected) && engine.zoom > 0.5) {
          const angle = Math.atan2(b.y - a.y, b.x - a.x);
          const x = b.x - Math.cos(angle) * (b.r + 3);
          const y = b.y - Math.sin(angle) * (b.r + 3);
          ctx2.fillStyle = edgeColor(link.type);
          ctx2.beginPath();
          ctx2.moveTo(x, y);
          ctx2.lineTo(x - Math.cos(angle - 0.42) * 7, y - Math.sin(angle - 0.42) * 7);
          ctx2.lineTo(x - Math.cos(angle + 0.42) * 7, y - Math.sin(angle + 0.42) * 7);
          ctx2.closePath();
          ctx2.fill();
        }
      }
      if (selectedLink) {
        const a = engine.nodeById.get(selectedLink.source);
        const b = engine.nodeById.get(selectedLink.target);
        if (a && b && visible(a) && visible(b)) {
          selectedGeom = { a, b };
          ctx2.globalAlpha = 1;
          ctx2.strokeStyle = '#ffffff';
          ctx2.lineWidth = 5.5;
          ctx2.beginPath();
          ctx2.moveTo(a.x, a.y);
          ctx2.lineTo(b.x, b.y);
          ctx2.stroke();
          ctx2.strokeStyle = '#111827';
          ctx2.lineWidth = 2.2;
          ctx2.beginPath();
          ctx2.moveTo(a.x, a.y);
          ctx2.lineTo(b.x, b.y);
          ctx2.stroke();
          const angle = Math.atan2(b.y - a.y, b.x - a.x);
          const x = b.x - Math.cos(angle) * (b.r + 3);
          const y = b.y - Math.sin(angle) * (b.r + 3);
          ctx2.fillStyle = '#111827';
          ctx2.beginPath();
          ctx2.moveTo(x, y);
          ctx2.lineTo(x - Math.cos(angle - 0.42) * 8, y - Math.sin(angle - 0.42) * 8);
          ctx2.lineTo(x - Math.cos(angle + 0.42) * 8, y - Math.sin(angle + 0.42) * 8);
          ctx2.closePath();
          ctx2.fill();
        }
      }
      const labelPool = engine.nodes
        .filter((node) => visible(node) && focusWeight(node) > 0.25)
        .sort((a, b) => (b.degree || 0) - (a.degree || 0))
        .slice(0, 9);
      const labelIds = new Set(labelPool.map((node) => node.id));
      const labelPoints = [];
      for (const node of engine.nodes) {
        if (!visible(node)) continue;
        const weight = focusWeight(node);
        if (weight <= 0.04) continue;
        const color = typeColor(node.type);
        ctx2.globalAlpha = Math.max(0.08, weight);
        if (hasFocus && focusSet.has(node.id)) {
          ctx2.beginPath();
          ctx2.arc(node.x, node.y, node.r + 6, 0, Math.PI * 2);
          ctx2.strokeStyle = 'rgba(15,118,110,.50)';
          ctx2.lineWidth = 2;
          ctx2.stroke();
        }
        ctx2.beginPath();
        ctx2.arc(node.x, node.y, node.r, 0, Math.PI * 2);
        ctx2.fillStyle = color;
        ctx2.fill();
        ctx2.strokeStyle = '#ffffff';
        ctx2.lineWidth = 1.4;
        ctx2.stroke();
        const isSelected = engine.selected === node.id;
        const isHover = engine.hover === node.id;
        if (isSelected || isHover) {
          ctx2.beginPath();
          ctx2.arc(node.x, node.y, node.r + 3.5, 0, Math.PI * 2);
          ctx2.strokeStyle = isSelected ? '#111827' : 'rgba(17,24,39,.45)';
          ctx2.lineWidth = isSelected ? 2 : 1.2;
          ctx2.stroke();
        }
        const showLabel = isSelected || isHover || (labelIds.has(node.id) && engine.zoom > 0.52);
        if (showLabel) {
          const lx = node.x;
          const ly = node.y + node.r + 4;
          const priority = isSelected || isHover;
          const labelFont = `${isSelected ? 600 : 500} ${isSelected ? 11.5 : 10}px -apple-system, "PingFang SC", sans-serif`;
          ctx2.font = labelFont;
          const labelWidth = ctx2.measureText(node.name).width;
          const crowded = !priority && labelPoints.some((point) =>
            Math.abs(point.x - lx) < (point.w + labelWidth) / 2 + 7 &&
            Math.abs(point.y - ly) < 13);
          if (!crowded) {
            labelPoints.push({ x: lx, y: ly, w: labelWidth });
            ctx2.globalAlpha = Math.min(1, Math.max(0.35, weight + 0.25));
            ctx2.textAlign = 'center';
            ctx2.textBaseline = 'top';
            ctx2.lineWidth = 3;
            ctx2.strokeStyle = 'rgba(255,255,255,.95)';
            ctx2.strokeText(node.name, lx, ly);
            ctx2.fillStyle = isSelected ? '#111827' : '#344054';
            ctx2.fillText(node.name, lx, ly);
          }
        }
      }
      if (selectedGeom && selectedLink) {
        const midX = (selectedGeom.a.x + selectedGeom.b.x) / 2;
        const midY = (selectedGeom.a.y + selectedGeom.b.y) / 2;
        const label = `${selectedLink.type} · ${REL_ZH[selectedLink.type] || selectedLink.type}`;
        ctx2.font = '600 10px -apple-system, "PingFang SC", sans-serif';
        const textWidth = ctx2.measureText(label).width;
        const boxWidth = textWidth + 12;
        const boxHeight = 17;
        const left = midX - boxWidth / 2;
        const top = midY - boxHeight - 5;
        ctx2.globalAlpha = 1;
        ctx2.fillStyle = '#ffffff';
        ctx2.strokeStyle = '#cbd5e1';
        ctx2.lineWidth = 1;
        ctx2.beginPath();
        ctx2.roundRect(left, top, boxWidth, boxHeight, 4);
        ctx2.fill();
        ctx2.stroke();
        ctx2.fillStyle = '#111827';
        ctx2.textAlign = 'center';
        ctx2.textBaseline = 'middle';
        ctx2.fillText(label, midX, top + boxHeight / 2 + 0.5);
      }
      ctx2.restore();
      ctx2.globalAlpha = 1;
    }

    function localPoint(event) {
      const rect = canvas.getBoundingClientRect();
      return { x: event.clientX - rect.left, y: event.clientY - rect.top };
    }

    function hitTest(point) {
      const x = (point.x - engine.pan.x) / engine.zoom;
      const y = (point.y - engine.pan.y) / engine.zoom;
      let best = null;
      let bestDistance = Infinity;
      for (const node of engine.nodes) {
        if (!visible(node) || focusWeight(node) < 0.05) continue;
        const distance = Math.hypot(x - node.x, y - node.y);
        if (distance <= node.r + 7 && distance < bestDistance) { best = node; bestDistance = distance; }
      }
      return best;
    }

    function distanceToSegment(px, py, x1, y1, x2, y2) {
      const dx = x2 - x1;
      const dy = y2 - y1;
      const length2 = dx * dx + dy * dy;
      if (length2 === 0) return Math.hypot(px - x1, py - y1);
      let t = ((px - x1) * dx + (py - y1) * dy) / length2;
      t = Math.max(0, Math.min(1, t));
      return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
    }

    function edgeHitTest(point) {
      const x = (point.x - engine.pan.x) / engine.zoom;
      const y = (point.y - engine.pan.y) / engine.zoom;
      const threshold = Math.max(4, 8 / engine.zoom);
      let best = null;
      let bestDistance = threshold;
      for (const link of engine.links) {
        if (link.id === engine.selectedEdge) continue;
        const a = engine.nodeById.get(link.source);
        const b = engine.nodeById.get(link.target);
        if (!a || !b || !visible(a) || !visible(b)) continue;
        if (Math.min(focusWeight(a), focusWeight(b)) < 0.08) continue;
        const distance = distanceToSegment(x, y, a.x, a.y, b.x, b.y);
        if (distance < bestDistance) { best = link; bestDistance = distance; }
      }
      return best;
    }

    canvas.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return;
      canvas.setPointerCapture(event.pointerId);
      const point = localPoint(event);
      const node = hitTest(point);
      engine.moved = false;
      if (node) {
        // A node under the pointer always wins over an edge.
        engine.dragging = { node, start: point, x: node.x, y: node.y };
        engine.selected = node.id;
        engine.selectedEdge = null;
        state.selectedEdge = null;
      } else {
        const edge = edgeHitTest(point);
        if (edge) {
          engine.edgePress = { edge, start: point };
        } else {
          engine.panning = { start: point, pan: { ...engine.pan } };
        }
      }
    });

    canvas.addEventListener('pointermove', (event) => {
      const point = localPoint(event);
      if (engine.edgePress) {
        const dx = point.x - engine.edgePress.start.x;
        const dy = point.y - engine.edgePress.start.y;
        if (Math.abs(dx) + Math.abs(dy) > 3) engine.moved = true;
        return;
      }
      if (engine.dragging) {
        const dx = (point.x - engine.dragging.start.x) / engine.zoom;
        const dy = (point.y - engine.dragging.start.y) / engine.zoom;
        if (Math.abs(dx) + Math.abs(dy) > 3) engine.moved = true;
        engine.dragging.node.x = engine.dragging.x + dx;
        engine.dragging.node.y = engine.dragging.y + dy;
        engine.dragging.node.vx = 0; engine.dragging.node.vy = 0;
        reheat();
        return;
      }
      if (engine.panning) {
        const dx = point.x - engine.panning.start.x;
        const dy = point.y - engine.panning.start.y;
        if (Math.abs(dx) + Math.abs(dy) > 3) engine.moved = true;
        engine.pan.x = engine.panning.pan.x + dx;
        engine.pan.y = engine.panning.pan.y + dy;
        engine.userInteracted = true;
        draw();
        return;
      }
      const node = hitTest(point);
      const edge = node ? null : edgeHitTest(point);
      const hoverId = node ? node.id : null;
      const hoverEdge = edge ? edge.id : null;
      if (hoverId !== engine.hover || hoverEdge !== engine.hoverEdge) {
        engine.hover = hoverId;
        engine.hoverEdge = hoverEdge;
        canvas.classList.toggle('node-hover', Boolean(node || edge));
        draw();
        if (node) showTooltip(node, point);
        else if (edge) showEdgeTooltip(edge, point);
        else showTooltip(null);
      } else if (node || edge) {
        positionTooltip(point);
      }
    });

    function finishPointer(event) {
      const point = localPoint(event);
      if (engine.edgePress) {
        const edge = engine.edgePress.edge;
        engine.edgePress = null;
        if (!engine.moved) selectEdge(edge.id);
      } else if (engine.dragging) {
        const node = engine.dragging.node;
        engine.dragging = null;
        if (!engine.moved) selectNode(node.id);
      } else if (engine.panning) {
        engine.panning = null;
        if (!engine.moved) {
          closeDetail();
          engine.selected = null;
          engine.selectedEdge = null;
          state.selectedNode = null;
          state.selectedEdge = null;
          draw();
        }
      }
      if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
    }
    canvas.addEventListener('pointerup', finishPointer);
    canvas.addEventListener('pointercancel', () => {
      engine.dragging = null;
      engine.panning = null;
      engine.edgePress = null;
    });
    canvas.addEventListener('pointerleave', () => {
      if (!engine.dragging && !engine.panning && !engine.edgePress) {
        engine.hover = null;
        engine.hoverEdge = null;
        draw();
        showTooltip(null);
      }
    });

    canvas.addEventListener('wheel', (event) => {
      event.preventDefault();
      const point = localPoint(event);
      const before = { x: (point.x - engine.pan.x) / engine.zoom, y: (point.y - engine.pan.y) / engine.zoom };
      const factor = Math.exp(-event.deltaY * 0.0011);
      engine.zoom = Math.max(0.28, Math.min(3.6, engine.zoom * factor));
      engine.pan.x = point.x - before.x * engine.zoom;
      engine.pan.y = point.y - before.y * engine.zoom;
      engine.userInteracted = true;
      draw();
    }, { passive: false });

    canvas.addEventListener('dblclick', () => { fit(); draw(); });

    function showTooltip(node, point) {
      const tooltip = $('graphTooltip');
      if (!node) { tooltip.hidden = true; return; }
      clear(tooltip);
      tooltip.append(h('strong', {}, node.name), h('span', { class: 'tt-type' }, `${TYPE_ZH[node.type] || node.type} · 连接 ${node.degree}`));
      if (node.project) tooltip.append(h('div', { class: 'tt-type' }, `项目：${node.project}`));
      tooltip.hidden = false;
      positionTooltip(point);
    }

    function showEdgeTooltip(edge, point) {
      const tooltip = $('graphTooltip');
      const a = engine.nodeById.get(edge.source);
      const b = engine.nodeById.get(edge.target);
      if (!a || !b) { tooltip.hidden = true; return; }
      clear(tooltip);
      tooltip.append(
        h('strong', {}, `${a.name} → ${b.name}`),
        h('span', { class: 'tt-type' }, `${edge.type} · ${REL_ZH[edge.type] || edge.type}`),
        h('div', { class: 'tt-type' }, `置信度 ${Number(edge.confidence ?? 1).toFixed(2)} · 点击查看这条边`),
      );
      tooltip.hidden = false;
      positionTooltip(point);
    }

    function positionTooltip(point) {
      const tooltip = $('graphTooltip');
      if (tooltip.hidden) return;
      tooltip.style.left = `${Math.min(engine.width - 240, point.x + 13)}px`;
      tooltip.style.top = `${Math.min(engine.height - 70, point.y + 13)}px`;
    }

    function selectNode(nodeId) {
      const node = engine.nodeById.get(nodeId);
      if (!node) return;
      engine.selected = nodeId;
      engine.selectedEdge = null;
      state.selectedNode = nodeId;
      state.selectedEdge = null;
      state.documentId = null;
      showView('graph');
      draw();
      renderEntityDetail(node);
    }

    function selectEdge(edgeId) {
      const link = engine.links.find((item) => item.id === edgeId);
      if (!link) return;
      engine.selectedEdge = edgeId;
      engine.selected = null;
      state.selectedEdge = edgeId;
      state.selectedNode = null;
      state.documentId = null;
      showView('graph');
      draw();
      renderEdgeDetail(link);
    }

    function centerOn(nodeId) {
      const node = engine.nodeById.get(nodeId);
      if (!node) return;
      engine.pan.x = engine.width / 2 - node.x * engine.zoom;
      engine.pan.y = engine.height / 2 - node.y * engine.zoom;
      draw();
    }

    function screenPointFor(nodeId) {
      const node = engine.nodeById.get(nodeId);
      if (!node) return null;
      return {
        x: node.x * engine.zoom + engine.pan.x,
        y: node.y * engine.zoom + engine.pan.y,
      };
    }

    function setSelected(nodeId) {
      engine.selected = nodeId;
      engine.selectedEdge = null;
      state.selectedNode = nodeId;
      state.selectedEdge = null;
      draw();
    }

    const observer = new ResizeObserver(resize);
    observer.observe(canvas);
    resize();

    return {
      setData, draw, resize, fit, warm, frame, reheat, selectNode, selectEdge, centerOn,
      screenPointFor, setSelected,
      get selected() { return engine.selected; },
      set selected(value) { engine.selected = value; },
      get selectedEdge() { return engine.selectedEdge; },
      set selectedEdge(value) { engine.selectedEdge = value; },
      nodes: () => engine.nodes,
      nodeById: () => engine.nodeById,
    };
  }

  // ---------- graph details ----------
  function detailStat(label, value) {
    return h('div', { class: 'detail-stat' }, h('span', {}, label), h('strong', {}, value));
  }

  function appendHighlighted(parent, text, term) {
    const value = String(text || '');
    const needle = String(term || '');
    if (!needle) { parent.append(document.createTextNode(value)); return; }
    const lower = value.toLowerCase();
    const lowerNeedle = needle.toLowerCase();
    let from = 0;
    let index = lower.indexOf(lowerNeedle, from);
    while (index !== -1) {
      if (index > from) parent.append(document.createTextNode(value.slice(from, index)));
      parent.append(h('mark', { class: 'entity-mark' }, value.slice(index, index + needle.length)));
      from = index + needle.length;
      index = lower.indexOf(lowerNeedle, from);
    }
    if (from < value.length) parent.append(document.createTextNode(value.slice(from)));
  }

  async function renderEntityDetail(node) {
    const panel = $('detailPanel');
    const body = $('detailBody');
    panel.hidden = false;
    clear(body);
    const color = typeColor(node.type);
    const docs = node.documents || [];
    const relations = (state.graph.links || [])
      .filter((link) => link.source === node.id || link.target === node.id);
    const byId = state.graphEngine?.nodeById?.() || new Map();

    const hero = h('div', { class: 'detail-hero' },
      h('div', { class: 'detail-hero-top' },
        h('span', { class: 'entity-type' },
          h('span', { class: 'dot', style: `background:${color}` }),
          h('span', {}, TYPE_ZH[node.type] || node.type),
          h('span', { class: 'entity-type-en' }, node.type)),
        h('span', { class: 'meta-chip' }, `度 ${node.degree || 0}`),
      ),
      h('h3', { class: 'detail-title' }, node.name),
      node.description
        ? h('p', { class: 'detail-desc' }, node.description)
        : h('p', { class: 'detail-desc muted' },
            docs.length
              ? `由 ${docs.length} 个文档中的 ${(node.chunk_ids || []).length} 个段落共同支撑；下方是可核对的原文。`
              : '这个实体暂时没有段落证据。'),
    );
    hero.style.setProperty('--entity-color', color);
    body.append(hero, h('div', { class: 'detail-stats' },
      detailStat('连接', fmt(node.degree || 0)),
      detailStat('文档', fmt(docs.length)),
      detailStat('段落', fmt((node.chunk_ids || []).length)),
      detailStat('项目', node.project || '未归属'),
    ));

    if (node.aliases?.length) {
      body.append(h('div', { class: 'detail-section' },
        h('div', { class: 'detail-section-head' }, h('h4', {}, '别名')),
        h('div', { class: 'chip-row' }, ...node.aliases.map((alias) => h('span', { class: 'alias-chip' }, alias))),
      ));
    }

    if (docs.length) {
      const section = h('div', { class: 'detail-section' },
        h('div', { class: 'detail-section-head' }, h('h4', {}, '来源文档'), h('span', { class: 'section-count' }, `${docs.length}`)));
      for (const doc of docs.slice(0, 7)) {
        const projectName = typeof doc.project === 'string' ? doc.project : doc.project?.name;
        section.append(h('button', { class: 'doc-mini', onclick: () => selectDocument(doc.id) },
          h('div', { class: 'doc-mini-top' },
            h('span', { class: 'doc-mini-title' }, doc.title),
            projectName ? h('span', { class: 'mini-project' },
              h('span', { class: 'dot', style: `background:${projectColor(projectName)}` }), projectName) : null,
          ),
          h('div', { class: 'doc-mini-meta' },
            h('span', {}, `修订 ${doc.version_seq}`),
            doc.date ? h('span', {}, doc.date) : null,
            h('span', { class: 'format-badge' }, formatBadge(doc.format)),
          ),
          doc.path ? h('div', { class: 'doc-mini-path mono' }, doc.path) : null,
        ));
      }
      if (docs.length > 7) section.append(h('div', { class: 'section-note' }, `另有 ${docs.length - 7} 个文档未展开`));
      body.append(section);
    }

    if (relations.length) {
      const section = h('div', { class: 'detail-section' },
        h('div', { class: 'detail-section-head' }, h('h4', {}, '关系'), h('span', { class: 'section-count' }, `${relations.length}`)));
      for (const link of relations.slice(0, 10)) {
        const source = byId.get(link.source);
        const target = byId.get(link.target);
        if (!source || !target) continue;
        const tone = relationColor(link.type);
        section.append(h('button', { class: 'relation-item', title: '点击查看这条有向关系', onclick: () => selectEdge(link.id) },
          h('div', { class: 'relation-top' },
            h('span', { class: 'relation-type-pill', style: `color:${tone};border-color:${tone}55;background:${tone}0f` },
              REL_ZH[link.type] || link.type),
            h('span', { class: 'relation-path' },
              h('span', { class: link.source === node.id ? 'current' : '' }, source.name),
              h('span', { class: 'arrow' }, '→'),
              h('span', { class: link.target === node.id ? 'current' : '' }, target.name)),
            h('span', { class: 'relation-conf' }, Number(link.confidence ?? 1).toFixed(2)),
          ),
          link.evidence ? h('div', { class: 'relation-evidence' }, `“${link.evidence.slice(0, 120)}”`) : null,
        ));
      }
      if (relations.length > 10) section.append(h('div', { class: 'section-note' }, `另有 ${relations.length - 10} 条关系未展开；点击上方任一条查看边的完整信息`));
      body.append(section);
    }

    const evidenceSection = h('div', { class: 'detail-section' },
      h('div', { class: 'detail-section-head' }, h('h4', {}, '段落证据（快照）'), h('span', { class: 'section-count' }, `${(node.chunk_ids || []).length}`)));
    evidenceSection.append(h('div', { class: 'section-note' }, '静态快照没有收录段落正文：下面是图谱快照里同一段落的抽取证据。'));
    body.append(evidenceSection);
    const ids = (node.chunk_ids || []).slice(0, 6);
    try {
      const data = snapshotEvidence(ids);
      clear(evidenceSection);
      evidenceSection.append(h('div', { class: 'detail-section-head' }, h('h4', {}, '段落证据（快照）'), h('span', { class: 'section-count' }, `${(node.chunk_ids || []).length}`)));
      if (!data.items?.length) {
        evidenceSection.append(h('div', { class: 'section-note' }, '没有可显示的段落证据。'));
      } else {
        for (const item of data.items) {
          const paragraph = h('p');
          appendHighlighted(paragraph, item.content.slice(0, 560), node.name);
          evidenceSection.append(h('div', { class: 'evidence-card' },
            h('div', { class: 'evidence-card-head' },
              h('button', { class: 'evidence-doc', onclick: () => selectDocument(item.document_id) }, item.title),
              h('span', {}, `修订 ${item.version_seq}`),
              h('span', { class: 'evidence-section-path' }, item.section_path || '')),
            paragraph,
          ));
        }
        evidenceSection.append(h('div', { class: 'section-note' },
          '静态快照没有收录段落正文：上面是图谱快照里同一段落的抽取证据。'));
      }
    } catch (error) {
      clear(evidenceSection);
      evidenceSection.append(h('div', { class: 'detail-section-head' }, h('h4', {}, '段落证据（快照）')),
        h('div', { class: 'section-note' }, `读取失败：${error.message}`));
    }

    body.append(h('div', { class: 'detail-actions' },
      h('button', { class: 'ghost small', onclick: () => centerOnNode(node.id) }, '在图中居中'),
      docs.length ? h('button', { class: 'ghost small', onclick: () => highlightDocumentEntities(docs[0].id) }, '高亮主要文档') : null,
    ));
    $('graphHint').textContent = '点击节点或关系查看详情 · 点击空白处取消选择 · 双击适应画布';
  }

  async function renderEdgeDetail(link) {
    const panel = $('detailPanel');
    const body = $('detailBody');
    const byId = state.graphEngine?.nodeById?.() || new Map();
    const source = byId.get(link.source);
    const target = byId.get(link.target);
    if (!source || !target) return;
    panel.hidden = false;
    clear(body);
    const tone = relationColor(link.type);
    const doc = (state.documents || []).find((item) => item.id === link.document_id);
    const docProject = doc ? (typeof doc.project === 'string' ? doc.project : doc.project?.name) : null;
    const confidence = Number(link.confidence ?? 1);
    const hero = h('div', { class: 'detail-hero edge-hero' },
      h('div', { class: 'detail-hero-top' },
        h('span', { class: 'entity-type' }, h('span', { class: 'dot', style: `background:${tone}` }),
          h('span', {}, '有向关系'), h('span', { class: 'entity-type-en' }, link.type)),
        h('span', { class: 'meta-chip' }, `置信度 ${confidence.toFixed(2)}`),
      ),
      h('h3', { class: 'detail-title' }, REL_ZH[link.type] || link.type),
      h('p', { class: 'detail-desc' }, `${link.type} · ${source.name} → ${target.name}`),
    );
    hero.style.setProperty('--entity-color', tone);

    const endpoint = (node, role) => h('button', { class: 'edge-endpoint', onclick: () => selectNode(node.id) },
      h('span', { class: 'edge-role' }, role),
      h('span', { class: 'edge-endpoint-name' },
        h('span', { class: 'dot', style: `background:${typeColor(node.type)}` }), node.name),
      h('span', { class: 'edge-endpoint-type' }, TYPE_ZH[node.type] || node.type),
    );

    body.append(hero);
    body.append(h('div', { class: 'detail-section' },
      h('div', { class: 'detail-section-head' }, h('h4', {}, '两端实体')),
      h('div', { class: 'edge-endpoints' }, endpoint(source, '从'), h('span', { class: 'edge-arrow' }, '→'), endpoint(target, '到')),
    ));
    body.append(h('div', { class: 'detail-section' },
      h('div', { class: 'detail-section-head' }, h('h4', {}, '置信度')),
      h('div', { class: 'confidence-row' },
        h('div', { class: 'confidence-track' }, h('div', { class: 'confidence-fill', style: `width:${Math.round(confidence * 100)}%;background:${tone}` })),
        h('span', { class: 'confidence-value' }, confidence.toFixed(2)),
      ),
    ));

    const evidenceSection = h('div', { class: 'detail-section' },
      h('div', { class: 'detail-section-head' }, h('h4', {}, '原文证据'), h('span', { class: 'section-count' }, link.chunk_id ? '段落' : '')),
    );
    if (link.evidence) {
      evidenceSection.append(h('blockquote', { class: 'edge-quote' }, `“${link.evidence}”`));
    } else {
      evidenceSection.append(h('div', { class: 'section-note' }, '这条关系没有保存原文证据。'));
    }
    if (doc) {
      evidenceSection.append(h('button', { class: 'doc-mini edge-doc', onclick: () => selectDocument(doc.id) },
        h('div', { class: 'doc-mini-top' }, h('span', { class: 'doc-mini-title' }, doc.title),
          docProject ? h('span', { class: 'mini-project' }, h('span', { class: 'dot', style: `background:${projectColor(docProject)}` }), docProject) : null),
        h('div', { class: 'doc-mini-meta' }, h('span', {}, `修订 ${doc.version_seq}`), doc.date ? h('span', {}, doc.date) : null,
          h('span', { class: 'format-badge' }, formatBadge(doc.format))),
        h('div', { class: 'doc-mini-path mono' }, doc.path || ''),
      ));
    } else if (link.document_id) {
      evidenceSection.append(h('div', { class: 'section-note' }, `来源文档：${link.document_id}`));
    }
    const chunkBox = h('div');
    evidenceSection.append(chunkBox);
    body.append(evidenceSection);

    if (link.chunk_id) {
      try {
        const data = snapshotEvidence(link.chunk_id ? [link.chunk_id] : []);
        const item = data.items?.[0];
        if (item) {
          chunkBox.append(h('div', { class: 'evidence-card' },
            h('div', { class: 'evidence-card-head' }, h('span', {}, item.title), h('span', {}, `修订 ${item.version_seq}`), h('span', { class: 'evidence-section-path' }, item.section_path || '')),
            h('p', {}, item.content.slice(0, 700)),
          ));
        }
      } catch (error) {
        chunkBox.append(h('div', { class: 'section-note' }, `段落读取失败：${error.message}`));
      }
    }

    body.append(h('div', { class: 'detail-actions' },
      h('button', { class: 'ghost small', onclick: () => selectNode(source.id) }, '定位源实体'),
      h('button', { class: 'ghost small', onclick: () => selectNode(target.id) }, '定位目标实体'),
      doc ? h('button', { class: 'ghost small', onclick: () => selectDocument(doc.id) }, '打开来源文档') : null,
    ));
    $('graphHint').textContent = '已选中一条边 · 点击两端实体可切换 · 点击空白处取消';
  }

  function centerOnNode(nodeId) {
    state.graphEngine?.centerOn?.(nodeId);
  }

  function closeDetail() {
    $('detailPanel').hidden = true;
    state.selectedNode = null;
    state.selectedEdge = null;
    state.documentId = null;
    if (state.graphEngine) {
      state.graphEngine.selected = null;
      state.graphEngine.selectedEdge = null;
      state.graphEngine.draw();
    }
  }

  // ---------- documents ----------

  async function selectDocument(documentId) {
    try {
      const doc = (state.documents || []).find((item) => item.id === documentId);
      if (!doc) throw new Error('快照里没有这个文档');
      state.documentId = documentId;
      state.selectedNode = null;
      state.selectedEdge = null;
      if (state.graphEngine) {
        state.graphEngine.selected = null;
        state.graphEngine.selectedEdge = null;
      }
      renderDocumentDetail(doc);
      highlightDocumentEntities(doc.id);
      showView('graph');
      renderDocTree();
    } catch (error) {
      toast(`打开文档失败：${error.message}`, true);
    }
  }

  function renderDocumentDetail(doc) {
    const panel = $('detailPanel');
    const body = $('detailBody');
    panel.hidden = false;
    clear(body);
    body.append(
      h('div', { class: 'detail-kicker' }, 'DOCUMENT'),
      h('h3', { class: 'detail-title' }, doc.title),
      h('div', { class: 'meta', style: 'display:flex;gap:6px;flex-wrap:wrap;margin:6px 0' },
        h('span', { class: 'format-badge' }, formatBadge(doc.format)),
        doc.project ? h('span', { class: 'type-pill' }, h('span', { class: 'dot', style: `background:${projectColor(doc.project.name)}` }), doc.project.name) : null,
        h('span', { class: `license-tag ${doc.license}` }, licenseLabel(doc.license)),
        h('span', { class: 'vbadge' }, `修订 ${doc.version_seq}${doc.is_current ? ' · 当前' : ' · 失效'}`),
      ),
      h('div', { class: 'detail-desc mono' }, doc.path),
      h('div', { class: 'detail-desc' },
        `日期 ${dateText(doc.date)} · ${doc.chunk_count} 段 · 归属来源 ${projectSourceLabel(doc.project_source)}` +
        (doc.project_confidence != null ? ` (${Number(doc.project_confidence).toFixed(2)})` : '') +
        ` · 许可 ${licenseLabel(doc.license)}`),
    );
    if (doc.project_evidence) body.append(h('div', { class: 'detail-desc' }, `归属证据：${doc.project_evidence}`));
    if (doc.authors?.length) body.append(h('div', { class: 'detail-desc' }, `作者：${doc.authors.join('、')}`));

    const actions = h('div', { class: 'answer-actions' },
      h('button', { class: 'ghost small', onclick: () => { highlightDocumentEntities(doc.id); toast('已在图谱中高亮本文档的实体'); } }, '在图谱中高亮'),
    );
    body.append(actions);

    const revisions = chainFor(doc)?.revisions || [];
    if (revisions.length > 1) {
      const section = h('div', { class: 'detail-section' }, h('h4', {}, '版本链（按入库顺序）'));
      for (const rev of revisions) {
        section.append(h('div', { class: 'evidence-item' },
          h('div', { class: 'ev-head' },
            h('span', {}, `修订 ${rev.version_seq} · ${rev.title}`),
            h('span', {}, rev.is_current ? '当前版本' : '已失效')),
          h('div', { class: 'muted' }, `${dateText(rev.date)} · ${rev.is_current ? '参与检索' : '所有读取路径均排除'}`),
          !rev.is_current ? h('button', { class: 'doc-link', style: 'border:0;background:none;padding:0;margin-top:4px;cursor:pointer', onclick: () => selectDocument(rev.id) }, '查看这一版 →') : null,
        ));
      }
      body.append(section);
    }

    if (doc.citations_out?.length || doc.citations_in?.length) {
      const section = h('div', { class: 'detail-section' }, h('h4', {}, '文档引用'));
      for (const cite of doc.citations_out || []) {
        section.append(h('div', { class: 'rel-row' }, h('span', {}, '本文档 →'), h('span', { class: 'rel-type' }, '引用'), h('span', {}, cite.title || cite.key)));
      }
      for (const cite of doc.citations_in || []) {
        section.append(h('div', { class: 'rel-row' }, h('span', {}, cite.title), h('span', { class: 'rel-type' }, '引用'), h('span', {}, '本文档')));
      }
      body.append(section);
    }

    const related = (state.graph.nodes || []).filter((node) => (node.document_ids || []).includes(doc.id));
    if (related.length) {
      body.append(h('div', { class: 'detail-section' },
        h('div', { class: 'detail-section-head' }, h('h4', {}, '本文档抽出的实体'), h('span', { class: 'section-count' }, `${related.length}`)),
        h('div', { class: 'chip-row' }, ...related.slice(0, 18).map((node) => h('button', {
          class: 'member-chip',
          title: TYPE_ZH[node.type] || node.type,
          onclick: () => selectNode(node.id),
        }, node.name))),
        related.length > 18 ? h('div', { class: 'section-note' }, `另有 ${related.length - 18} 个实体未展开`) : null,
      ));
    }

    const quotes = [];
    const seenQuotes = new Set();
    for (const link of state.graph.links || []) {
      if (link.document_id !== doc.id || !link.evidence || seenQuotes.has(link.evidence)) continue;
      seenQuotes.add(link.evidence);
      quotes.push(link.evidence);
    }
    const quoteSection = h('div', { class: 'detail-section' },
      h('div', { class: 'detail-section-head' }, h('h4', {}, '关系证据（快照）'), h('span', { class: 'section-count' }, `${quotes.length}`)),
    );
    for (const quote of quotes.slice(0, 8)) quoteSection.append(h('div', { class: 'edge-quote' }, `“${quote}”`));
    quoteSection.append(h('div', { class: 'section-note' }, '静态快照保存图谱与抽取证据，没有收录文档正文段落。'));
    body.append(quoteSection);
    $('graphHint').textContent = '已高亮本文档抽出的实体 · 点击节点查看证据 · 双击适应画布';
  }

  function highlightDocumentEntities(documentId) {
    const ids = new Set();
    for (const node of state.graph.nodes || []) {
      if ((node.document_ids || []).includes(documentId)) ids.add(node.id);
    }
    state.evidenceEntityIds = ids;
    state.evidenceChunkIds = new Set();
    $('clearHighlight').hidden = ids.size === 0;
    if (state.graphEngine) { state.graphEngine.reheat?.(); state.graphEngine.draw(); }
  }

  function selectNode(nodeId) {
    state.graphEngine?.selectNode?.(nodeId);
  }

  function selectEdge(edgeId) {
    state.graphEngine?.selectEdge?.(edgeId);
  }

  // ---------- graph legend ----------
  function renderGraphLegend() {
    const box = $('graphLegend');
    clear(box);
    const types = [...new Set((state.graph.nodes || []).map((node) => node.type))].sort();
    if (!types.length) { box.hidden = true; return; }
    box.hidden = false;
    for (const type of types) {
      const item = h('button', {
        class: 'legend-item' + (state.hiddenTypes.has(type) ? ' off' : ''),
        title: `隐藏/显示 ${TYPE_ZH[type] || type}`,
        onclick: () => {
          if (state.hiddenTypes.has(type)) state.hiddenTypes.delete(type);
          else state.hiddenTypes.add(type);
          renderGraphLegend();
          state.graphEngine?.draw();
        },
      }, h('span', { class: 'swatch', style: `background:${typeColor(type)}` }), TYPE_ZH[type] || type);
      box.append(item);
    }
  }

  // ---------- views ----------
  function showView(view) {
    state.view = view;
    for (const tab of document.querySelectorAll('.tab')) {
      const active = tab.dataset.view === view;
      tab.classList.toggle('active', active);
      tab.setAttribute('aria-selected', String(active));
    }
    $('graphCanvas').hidden = view !== 'graph';
    $('graphLegend').hidden = view !== 'graph' || !(state.graph.nodes || []).length;
    $('graphHint').hidden = view !== 'graph';
    $('graphTooltip').hidden = true;
    $('timelineView').hidden = view !== 'timeline';
    $('communitiesView').hidden = view !== 'communities';
    if (view === 'graph') { state.graphEngine?.resize(); state.graphEngine?.draw(); }
    else $('detailPanel').hidden = true;
  }


  // ---------- pre-recorded playback ----------
  const SCRIPT_STAGES = [
    { stage: 'vector', candidates: 38, ms: 462 },
    { stage: 'keyword', candidates: 24, ms: 318 },
    { stage: 'graph', candidates: 17, ms: 505 },
    { stage: 'rerank', candidates: 8, ms: 731 },
  ];
  const SCRIPT_QUESTION = PLAYBACK.question || '远山项目的预算总额是多少？';
  const SCRIPT_ANSWER = PLAYBACK.answer || '远山项目的预算总额为 48 万元 [1]。';
  const SCRIPT_LAYERS = { vector: 5, keyword: 4, graph: 3 };

  function wait(ms, token) {
    return new Promise((resolve) => setTimeout(() => resolve(state.playback.token === token), ms));
  }

  function playbackSource() {
    const chunkId = PLAYBACK.chunk_id;
    const doc = (state.documents || []).find((item) => item.id === PLAYBACK.document_id);
    const lines = [];
    const seen = new Set();
    for (const link of state.graph.links || []) {
      if (link.chunk_id !== chunkId || !link.evidence || seen.has(link.evidence)) continue;
      seen.add(link.evidence);
      lines.push(link.evidence);
    }
    return {
      index: 1,
      title: `${doc?.title || '远山项目立项书 v2'} · ${PLAYBACK.section || '预算'}`,
      document_id: PLAYBACK.document_id,
      license_class: doc?.license || 'public',
      snippet: lines.join('\n'),
      layers: Object.keys(SCRIPT_LAYERS),
      score: 0.8123,
    };
  }

  function playbackNodes() {
    return (state.graph.nodes || []).filter((node) => (node.chunk_ids || []).includes(PLAYBACK.chunk_id));
  }

  function playbackShell() {
    const box = $('answerBox');
    clear(box);
    box.append(h('div', { class: 'answer-live' },
      h('div', { class: 'stage-line' }, h('span', { class: 'stage-text' }, '预录开始…')),
      h('div', { class: 'answer-text' }),
    ));
  }

  function setStageLine(text, busy = true) {
    const line = document.querySelector('.answer-live .stage-line');
    if (!line) return;
    clear(line);
    if (busy) line.append(h('span', { class: 'spinner' }));
    line.append(h('span', { class: 'stage-text' }, text));
  }

  function renderScriptedText(text, sources = []) {
    const textBox = document.querySelector('.answer-live .answer-text');
    if (!textBox) return;
    clear(textBox);
    const valid = new Set((sources || []).map((source) => source.index));
    const regex = /\[(\d+)\]/g;
    let last = 0;
    let match;
    while ((match = regex.exec(text))) {
      if (match.index > last) textBox.append(document.createTextNode(text.slice(last, match.index)));
      const index = Number(match[1]);
      textBox.append(h('button', {
        class: 'cite-btn' + (valid.has(index) ? '' : ' uncited'),
        title: valid.has(index) ? `查看来源 ${index}` : '这个编号还没有对应来源',
        onclick: () => focusSource(index),
      }, `[${index}]`));
      last = regex.lastIndex;
    }
    if (last < text.length) textBox.append(document.createTextNode(text.slice(last)));
  }

  function traceRow(stage) {
    const width = Math.max(6, Math.min(100, (Math.log10(stage.ms + 1) / Math.log10(30000)) * 100));
    const fill = h('div', {
      class: 'trace-fill success',
      style: `width:0%;transition-duration:${Math.min(900, stage.ms)}ms`,
    });
    requestAnimationFrame(() => { fill.style.width = `${width}%`; });
    return h('div', { class: 'trace-row' },
      h('span', { class: 'trace-name' }, STAGE_ZH[stage.stage] || stage.stage),
      h('div', { class: 'trace-track', title: `${stage.candidates} 候选 · ${stage.ms} ms` }, fill),
      h('span', { class: 'trace-ms' }, `${stage.candidates} 候选 · ${stage.ms}ms`),
    );
  }

  function renderScriptedSources(sources) {
    const box = $('sourcesBox');
    clear(box);
    if (!sources.length) return;
    box.append(h('div', { class: 'sources-title' }, '来源', h('span', {}, '预录 · 1 个来源 · 点击可在图谱中定位')));
    for (const source of sources) {
      box.append(h('div', {
        class: 'source-card cited',
        dataset: { index: String(source.index) },
        onclick: () => focusSource(source.index, true),
      },
        h('div', { class: 'source-head' },
          h('span', { class: 'source-index' }, `[${source.index}]`),
          h('span', { class: 'source-title' }, source.title),
        ),
        h('div', { class: 'source-meta' },
          h('span', { class: 'prelim-tag' }, '预录'),
          h('span', { class: `license-tag ${source.license_class}` }, licenseLabel(source.license_class)),
          ...source.layers.map((layer) => h('span', { class: 'layer-pill' }, STAGE_ZH[layer] || layer)),
          h('span', {}, `score ${source.score.toFixed(4)}`),
        ),
        h('div', { class: 'source-snippet' }, source.snippet),
      ));
    }
  }

  function focusSource(index, highlightDocOnly = false) {
    const card = document.querySelector(`.source-card[data-index="${index}"]`);
    if (card) {
      card.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      card.style.outline = '1px solid rgba(15,118,110,.55)';
      setTimeout(() => { card.style.outline = ''; }, 1200);
    }
    const source = index === 1 ? playbackSource() : null;
    if (source?.document_id) highlightDocumentEntities(source.document_id);
    if (!highlightDocOnly && source) toast(`来源 ${index} · ${source.title}`);
  }

  function renderPlaybackEnd(seconds) {
    document.querySelector('.prelim-end')?.remove();
    $('askScroll').prepend(h('div', { class: 'prelim-end' },
      h('div', { class: 'prelim-end-main' },
        h('strong', {}, '预录结束'),
        h('span', {}, '以上问答是固定脚本：没有调用模型、没有检索、没有网络请求，也没有写入任何数据。'),
      ),
      h('button', { class: 'ghost small', onclick: playDemo }, '↻ 重播'),
    ));
    const live = document.querySelector('.answer-live');
    if (live) {
      live.append(h('div', { class: 'answer-meta' },
        h('span', {}, `${seconds.toFixed(1)} s（预录播放）`),
        h('span', {}, '1 个来源'),
        h('span', { class: 'good' }, '✓ 1 条引用'),
        h('span', { class: 'prelim-tag' }, '预录'),
      ));
    }
    $('askState').textContent = '预录结束';
    $('playBtn').disabled = false;
    $('playBtn').textContent = '↻ 重播预录演示';
    state.playback.running = false;
  }

  async function playDemo() {
    state.playback.token += 1;
    const token = state.playback.token;
    const started = Date.now();
    if (state.playback.running) return;
    state.playback.running = true;
    const alive = () => state.playback.token === token;

    $('playBtn').disabled = true;
    $('playBtn').textContent = '播放中…（预录）';
    $('askState').textContent = '预录播放中';
    document.querySelector('.prelim-end')?.remove();
    clear($('traceBox'));
    clear($('sourcesBox'));
    state.evidenceChunkIds = new Set();
    state.evidenceEntityIds = new Set();
    $('clearHighlight').hidden = true;
    state.documentId = null;
    closeDetail();
    showView('graph');
    state.graphEngine?.draw();
    $('question').value = '';
    $('questionCount').textContent = '0/500';
    playbackShell();
    setStageLine('预录：正在输入固定问题…', false);

    for (let i = 0; i < SCRIPT_QUESTION.length; i += 1) {
      $('question').value = SCRIPT_QUESTION.slice(0, i + 1);
      $('questionCount').textContent = `${i + 1}/500`;
      if (!(await wait(52, token))) return;
      if (!alive()) return;
    }
    if (!(await wait(420, token))) return;

    setStageLine('四路并行检索 · 预录轨迹', true);
    const traceBox = $('traceBox');
    traceBox.append(h('div', { class: 'trace-title' }, '预录轨迹',
      h('span', { class: 'prelim-tag' }, '预录'),
      h('span', {}, '固定计数与耗时 · 非实时检索')));
    const rows = h('div', { class: 'trace-rows' });
    traceBox.append(rows);
    if (!(await wait(260, token))) return;
    for (const stage of SCRIPT_STAGES) {
      rows.append(traceRow(stage));
      if (!(await wait(210, token))) return;
    }
    if (!(await wait(760, token))) return;

    setStageLine('证据已收集 · 准备生成', true);
    const hitNodes = playbackNodes();
    state.evidenceEntityIds = new Set(hitNodes.map((node) => node.id));
    $('clearHighlight').hidden = hitNodes.length === 0;
    state.graphEngine?.frame?.(hitNodes.map((node) => node.id));
    state.graphEngine?.draw();
    if (hitNodes.length) {
      $('graphHint').textContent = `预录高亮：${hitNodes.length} 个实体与预录证据相关 · 点击节点查看证据`;
    }
    const pills = h('div', { class: 'layer-pills' });
    for (const [layer, count] of Object.entries(SCRIPT_LAYERS)) {
      pills.append(h('span', { class: 'layer-pill' }, `${STAGE_ZH[layer] || layer} ${count}`));
    }
    traceBox.append(pills);
    if (!(await wait(420, token))) return;

    setStageLine('生成中 · 预录回答', true);
    const sources = [playbackSource()];
    for (let i = 1; i <= SCRIPT_ANSWER.length; i += 1) {
      renderScriptedText(SCRIPT_ANSWER.slice(0, i));
      if (!(await wait(38, token))) return;
    }
    renderScriptedText(SCRIPT_ANSWER);
    if (!(await wait(220, token))) return;

    renderScriptedText(SCRIPT_ANSWER, sources);
    renderScriptedSources(sources);
    if (!(await wait(420, token))) return;

    const line = document.querySelector('.answer-live .stage-line');
    if (line) line.remove();
    renderPlaybackEnd((Date.now() - started) / 1000);
    toast('预录演示结束 · 点「↻ 重播」可再看一次');
  }

  function renderExamples() {
    const box = $('examples');
    clear(box);
    for (const example of EXAMPLES) {
      box.append(h('button', {
        class: 'example-chip',
        title: example,
        onclick: () => {
          $('question').value = example;
          $('questionCount').textContent = `${example.length}/500`;
          $('question').focus();
        },
      }, example));
    }
  }


  // ---------- events ----------
  function unavailable(label) {
    return () => toast(`${label}在静态版不可用：没有后端、不调用模型、也不需要 API Key`, true);
  }

  function bindEvents() {
    $('settingsBtn').addEventListener('click', unavailable('模型设置'));
    $('buildBtn').addEventListener('click', unavailable('重建图谱'));
    $('snapshotInfoBtn').addEventListener('click', () => {
      renderSnapshotInfo();
      $('snapshotModal').hidden = false;
    });
    $('detailClose').addEventListener('click', closeDetail);
    $('playBtn').addEventListener('click', playDemo);
    $('askBtn').addEventListener('click', () => toast('静态版不调用模型：点「▶ 播放预录演示」看预录轨迹', true));
    $('stopBtn').addEventListener('click', () => toast('预录播放没有可中断的请求；点「↻ 重播」可重放', true));
    $('clearHighlight').addEventListener('click', () => {
      state.evidenceEntityIds = new Set();
      state.evidenceChunkIds = new Set();
      state.searchTerm = '';
      $('entitySearch').value = '';
      $('clearHighlight').hidden = true;
      $('graphHint').textContent = '拖拽节点 · 滚轮缩放 · 点击节点或边查看详情';
      state.graphEngine?.draw();
      toast('已清除高亮');
    });
    $('question').addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        toast('静态版不调用模型：点「▶ 播放预录演示」看预录轨迹', true);
      }
    });
    $('question').addEventListener('input', () => {
      $('questionCount').textContent = `${$('question').value.length}/500`;
    });
    $('projectFilter').addEventListener('change', (event) => {
      state.projectFilterId = event.target.value;
      renderProjectChips();
      state.graphEngine?.draw();
    });
    $('showSuperseded').addEventListener('change', (event) => {
      state.showSuperseded = event.target.checked;
      renderDocTree();
    });
    $('entitySearch').addEventListener('input', (event) => {
      state.searchTerm = event.target.value.trim();
      $('clearHighlight').hidden = !state.searchTerm && !state.evidenceEntityIds.size;
      state.graphEngine?.draw();
    });
    $('entitySearch').addEventListener('keydown', (event) => {
      if (event.key !== 'Enter') return;
      const term = state.searchTerm.toLowerCase();
      const match = (state.graph.nodes || []).find((node) => String(node.name).toLowerCase().includes(term));
      if (match) selectNode(match.id);
    });
    $('railToggle').addEventListener('click', () => {
      const layout = $('layout');
      if (window.innerWidth <= 980) layout.classList.toggle('rail-open');
      else layout.classList.toggle('rail-hidden');
    });
    for (const modal of document.querySelectorAll('.modal-backdrop')) {
      modal.addEventListener('mousedown', (event) => { if (event.target === modal) modal.hidden = true; });
    }
    for (const button of document.querySelectorAll('[data-close]')) {
      button.addEventListener('click', () => { $(button.dataset.close).hidden = true; });
    }
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        if (!$('snapshotModal').hidden) $('snapshotModal').hidden = true;
        else closeDetail();
      }
    });
    for (const tab of document.querySelectorAll('.tab')) {
      tab.addEventListener('click', () => showView(tab.dataset.view));
    }
    window.addEventListener('resize', () => {
      if (window.innerWidth > 980) $('layout').classList.remove('rail-open');
      state.graphEngine?.resize?.();
    });
  }

  function boot() {
    bindEvents();
    renderExamples();
    loadSnapshot();
    renderStatus();
    renderProjectSelect();
    renderProjectChips();
    renderDocTree();
    renderTimeline();
    renderCommunities();
    renderGraphLegend();
    initGraph();
    renderSnapshotInfo();
  }

  document.addEventListener('DOMContentLoaded', boot);
})();
