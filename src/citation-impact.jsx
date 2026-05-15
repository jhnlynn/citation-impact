import { useState, useRef, useCallback } from "react";
import { BarChart, Bar, AreaChart, Area, PieChart, Pie, Cell, XAxis, YAxis, Tooltip, ResponsiveContainer } from "recharts";

const C = {
  bg: "#060b16", surface: "#0d1424", surfaceLight: "#141e33", border: "#1a2744",
  accent: "#d4a012", accentDim: "#d4a01233", blue: "#4d8ef7", blueDim: "#4d8ef722",
  cyan: "#22d3ee", emerald: "#34d399", emeraldDim: "#34d39922", rose: "#fb7185",
  purple: "#a78bfa", text: "#e8edf5", textSec: "#8694ad", textMut: "#556378",
};
const PIE_C = [C.blue, C.accent, C.emerald, C.rose, C.purple, C.cyan];
const S2 = "/api/s2/graph/v1";

const INDUSTRY_KW = ["google","deepmind","meta ","facebook","microsoft","amazon","apple inc","ibm","nvidia","openai","anthropic","baidu","tencent","alibaba","samsung","intel","adobe","salesforce","huawei","bytedance","uber","tesla"];
const GOV_KW = ["nih","nist","nasa","national lab","doe ","nsf","darpa","army","navy","defense","government","national institute","cdc","fda"];
const MED_KW = ["hospital","clinic","medical center","health system","mayo clinic","johns hopkins medicine"];

function classifySector(aff) {
  if (!aff) return "Unknown";
  const l = aff.toLowerCase();
  if (INDUSTRY_KW.some(k => l.includes(k))) return "Industry";
  if (GOV_KW.some(k => l.includes(k))) return "Government";
  if (MED_KW.some(k => l.includes(k))) return "Medical";
  return "University";
}

let _apiKey = "";
const getDelay = () => _apiKey ? 350 : 1200;

async function s2f(path, retries = 4) {
  for (let i = 0; i <= retries; i++) {
    const headers = { "Accept": "application/json" };
    if (_apiKey) headers["x-api-key"] = _apiKey;
    const r = await fetch(`${S2}${path}`, { headers });
    if (r.status === 429) {
      const backoff = _apiKey ? 2000 * (i + 1) : 5000 * (i + 1);
      await new Promise(x => setTimeout(x, backoff));
      continue;
    }
    if (!r.ok) throw new Error(`API error ${r.status}`);
    return r.json();
  }
  throw new Error("Rate limited — try again in a minute, or add an API key");
}
const wait = ms => new Promise(r => setTimeout(r, ms));

function detectInput(q) {
  const t = q.trim();
  if (/^10\.\d{4,}\//.test(t)) return { type: "doi", id: `DOI:${t}` };
  if (/^\d{4}\.\d{4,}/.test(t)) return { type: "arxiv", id: `ARXIV:${t}` };
  const s2m = t.match(/semanticscholar\.org\/paper\/[^/]*?\/([a-f0-9]{40})/i) || t.match(/semanticscholar\.org\/paper\/([a-f0-9]{40})/i);
  if (s2m) return { type: "s2", id: s2m[1] };
  const axm = t.match(/arxiv\.org\/abs\/(\d{4}\.\d{4,})/);
  if (axm) return { type: "arxiv", id: `ARXIV:${axm[1]}` };
  return { type: "search", id: t };
}

const TT = ({ active, payload, label }) => {
  if (!active || !payload?.length) return null;
  return (
    <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 8, padding: "10px 14px", fontSize: 13, color: C.text }}>
      <div style={{ fontWeight: 600, marginBottom: 4 }}>{label}</div>
      {payload.map((p, i) => <div key={i} style={{ color: p.color }}>{p.name}: {p.value?.toLocaleString?.() ?? p.value}</div>)}
    </div>
  );
};

function Hdr({ children, sub }) {
  return (
    <div style={{ marginBottom: 20 }}>
      <h2 style={{ fontSize: 20, fontWeight: 700, color: C.text, fontFamily: "'Playfair Display', serif", margin: 0, borderLeft: `3px solid ${C.accent}`, paddingLeft: 14 }}>{children}</h2>
      {sub && <p style={{ fontSize: 12, color: C.textMut, margin: "5px 0 0 17px", fontFamily: "'JetBrains Mono', monospace" }}>{sub}</p>}
    </div>
  );
}

export default function App() {
  const [view, setView] = useState("landing");
  const [query, setQuery] = useState("");
  const [results, setResults] = useState([]);
  const [searching, setSearching] = useState(false);
  const [paper, setPaper] = useState(null);
  const [prog, setProg] = useState({ pct: 0, msg: "" });
  const [data, setData] = useState(null);
  const [tab, setTab] = useState("overview");
  const [err, setErr] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [showKeyInput, setShowKeyInput] = useState(false);
  const abort = useRef(false);

  const updateKey = (k) => { setApiKey(k); _apiKey = k; };

  const search = useCallback(async () => {
    const q = query.trim();
    if (!q) return;
    setErr("");
    setSearching(true);
    const inp = detectInput(q);
    try {
      if (inp.type !== "search") {
        const p = await s2f(`/paper/${encodeURIComponent(inp.id)}?fields=paperId,title,authors,year,citationCount,venue,url,externalIds`);
        setResults([p]);
      } else {
        const res = await s2f(`/paper/search?query=${encodeURIComponent(q)}&fields=paperId,title,authors,year,citationCount,venue,url&limit=8`);
        setResults(res.data || []);
        if (!res.data?.length) setErr("No papers found. Try different keywords.");
      }
      setView("results");
    } catch (e) {
      setErr("Search failed: " + e.message);
    }
    setSearching(false);
  }, [query]);

  const analyze = useCallback(async (p) => {
    setPaper(p);
    setView("analyzing");
    setTab("overview");
    abort.current = false;
    setProg({ pct: 5, msg: "Fetching paper details…" });

    try {
      const full = await s2f(`/paper/${p.paperId}?fields=paperId,title,authors,year,citationCount,venue,url,externalIds,fieldsOfStudy`);
      setPaper(full);
      if (abort.current) return;
      await wait(getDelay());
      setProg({ pct: 10, msg: "Loading citations…" });

      let allCit = [];
      let off = 0;
      const batch = 500;
      const max = 2000;
      while (off < max) {
        if (abort.current) return;
        const b = await s2f(`/paper/${p.paperId}/citations?fields=title,authors,year,venue,citationCount,url&limit=${batch}&offset=${off}`);
        const items = (b.data || []).map(x => x.citingPaper).filter(x => x?.paperId);
        allCit.push(...items);
        if ((b.data || []).length < batch) break;
        off += batch;
        setProg({ pct: 10 + Math.min(50, (allCit.length / Math.max(full.citationCount || 1, 1)) * 50), msg: `Loaded ${allCit.length} citations…` });
        await wait(getDelay());
      }

      if (abort.current) return;
      setProg({ pct: 62, msg: "Analyzing venues & papers…" });
      await wait(150);

      const yearMap = {}, venueMap = {}, authorFreq = {};
      const highlyCited = [];
      for (const cp of allCit) {
        if (cp.year) yearMap[cp.year] = (yearMap[cp.year] || 0) + 1;
        if (cp.venue) venueMap[cp.venue] = (venueMap[cp.venue] || 0) + 1;
        if (cp.citationCount >= 100) highlyCited.push(cp);
        if (cp.authors) for (const a of cp.authors) {
          if (a.authorId) {
            if (!authorFreq[a.authorId]) authorFreq[a.authorId] = { ...a, count: 0 };
            authorFreq[a.authorId].count++;
          }
        }
      }

      const years = Object.keys(yearMap).sort();
      let cum = 0;
      const timeline = years.map(y => { cum += yearMap[y]; return { year: y, annual: yearMap[y], cumulative: cum }; });
      const venues = Object.entries(venueMap).filter(([v]) => v.length > 1).sort((a, b) => b[1] - a[1]).slice(0, 15).map(([name, count]) => ({ name, count }));
      const topAuthors = Object.values(authorFreq).sort((a, b) => b.count - a.count).slice(0, 25);

      setProg({ pct: 68, msg: "Fetching author profiles…" });
      const enriched = [];
      const toFetch = Math.min(topAuthors.length, _apiKey ? 20 : 10);
      for (let i = 0; i < toFetch; i++) {
        if (abort.current) return;
        try {
          await wait(getDelay());
          const ad = await s2f(`/author/${topAuthors[i].authorId}?fields=name,hIndex,citationCount,affiliations,paperCount,url`);
          enriched.push({ ...ad, citingCount: topAuthors[i].count });
          setProg({ pct: 68 + ((i + 1) / toFetch) * 28, msg: `Profiling author ${i + 1}/${toFetch}…` });
        } catch { /* skip rate-limited authors */ }
      }

      const instMap = {};
      for (const a of enriched) {
        const aff = a.affiliations?.[0];
        if (aff) {
          if (!instMap[aff]) instMap[aff] = { name: aff, count: 0, sector: classifySector(aff) };
          instMap[aff].count += a.citingCount;
        }
      }
      const institutions = Object.values(instMap).sort((a, b) => b.count - a.count).slice(0, 12);
      const sectorMap = {};
      for (const inst of institutions) sectorMap[inst.sector] = (sectorMap[inst.sector] || 0) + inst.count;
      const sectors = Object.entries(sectorMap).map(([name, value]) => ({ name, value })).sort((a, b) => b.value - a.value);

      setProg({ pct: 99, msg: "Generating report…" });
      await wait(200);

      setData({
        totalCitations: allCit.length,
        totalCitationCount: full.citationCount || allCit.length,
        uniqueAuthors: Object.keys(authorFreq).length,
        uniqueInstitutions: new Set(enriched.map(a => a.affiliations?.[0]).filter(Boolean)).size,
        timeline, venues,
        highlyCited: highlyCited.sort((a, b) => (b.citationCount || 0) - (a.citationCount || 0)).slice(0, 20),
        scholars: enriched.filter(a => a.hIndex > 0).sort((a, b) => (b.hIndex || 0) - (a.hIndex || 0)),
        institutions, sectors,
        truncated: allCit.length < (full.citationCount || 0),
      });
      setView("dashboard");
    } catch (e) {
      setErr(`Analysis failed: ${e.message}`);
      setView("results");
    }
  }, []);

  const summary = data && paper ? (() => {
    const parts = [];
    parts.push(`This work has been cited ${data.totalCitationCount.toLocaleString()} times by ${data.uniqueAuthors.toLocaleString()} unique authors.`);
    const ti = data.institutions.slice(0, 3).map(i => i.name);
    if (ti.length) parts.push(`Citing institutions include ${ti.join(", ")}.`);
    const ts = data.scholars.slice(0, 3);
    if (ts.length) parts.push(`It has been recognized by prominent scholars including ${ts.map(s => `${s.name} (h-index: ${s.hIndex})`).join(", ")}.`);
    if (data.highlyCited.length) parts.push(`${data.highlyCited.length} highly-cited paper${data.highlyCited.length > 1 ? "s" : ""} (100+ citations) reference this work.`);
    const tv = data.venues.slice(0, 3).map(v => v.name);
    if (tv.length) parts.push(`Citations appear in leading venues such as ${tv.join(", ")}.`);
    if (data.timeline.length >= 2) {
      const f = data.timeline[0], l = data.timeline[data.timeline.length - 1];
      parts.push(`Citation velocity grew from ${f.annual} (${f.year}) to ${l.annual} (${l.year}), demonstrating sustained and accelerating research impact.`);
    }
    return parts.join(" ");
  })() : "";

  return (
    <div style={{ minHeight: "100vh", background: C.bg, color: C.text, fontFamily: "'DM Sans', sans-serif" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Playfair+Display:wght@400;600;700;900&family=DM+Sans:wght@300;400;500;600;700&family=JetBrains+Mono:wght@400;500;600&display=swap');
        @keyframes fadeUp { from { opacity:0; transform:translateY(20px) } to { opacity:1; transform:translateY(0) } }
        @keyframes fadeIn { from { opacity:0 } to { opacity:1 } }
        @keyframes pulse { 0%,100%{opacity:.4} 50%{opacity:1} }
        @keyframes barGrow { from { width:0 } }
        * { box-sizing:border-box; margin:0; padding:0 }
        input:focus,button:focus { outline:none }
        ::-webkit-scrollbar{width:5px} ::-webkit-scrollbar-track{background:transparent} ::-webkit-scrollbar-thumb{background:${C.border};border-radius:3px}
        a{color:${C.blue};text-decoration:none} a:hover{text-decoration:underline}
      `}</style>

      {/* ======= LANDING ======= */}
      {view === "landing" && (
        <div style={{ position: "relative" }}>
          <div style={{ position: "fixed", inset: 0, overflow: "hidden", pointerEvents: "none" }}>
            <div style={{ position: "absolute", width: 600, height: 600, borderRadius: "50%", background: "radial-gradient(circle, rgba(77,142,247,0.07) 0%, transparent 70%)", top: -150, right: -100 }} />
            <div style={{ position: "absolute", width: 500, height: 500, borderRadius: "50%", background: "radial-gradient(circle, rgba(212,160,18,0.05) 0%, transparent 70%)", bottom: -100, left: -80 }} />
          </div>
          <nav style={{ position: "relative", zIndex: 10, display: "flex", alignItems: "center", gap: 12, padding: "20px 36px", borderBottom: `1px solid ${C.border}` }}>
            <div style={{ width: 34, height: 34, borderRadius: 9, background: `linear-gradient(135deg, ${C.accent}, ${C.blue})`, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 17, fontWeight: 700, color: C.bg }}>C</div>
            <span style={{ fontSize: 19, fontWeight: 700, fontFamily: "'Playfair Display', serif" }}>CitationImpact</span>
          </nav>
          <div style={{ position: "relative", zIndex: 1, maxWidth: 820, margin: "0 auto", padding: "90px 36px 50px", textAlign: "center" }}>
            <div style={{ animation: "fadeUp 0.7s ease both" }}>
              <div style={{ display: "inline-block", padding: "5px 14px", background: C.surfaceLight, border: `1px solid ${C.border}`, borderRadius: 999, fontSize: 11, color: C.accent, fontFamily: "'JetBrains Mono', monospace", marginBottom: 28, letterSpacing: "0.08em" }}>✦ RESEARCH IMPACT ANALYSIS</div>
              <h1 style={{ fontSize: 50, fontWeight: 900, fontFamily: "'Playfair Display', serif", lineHeight: 1.1, marginBottom: 22, letterSpacing: "-0.02em" }}>
                Know <span style={{ color: C.accent }}>who</span> cites your work.<br />Know <span style={{ color: C.blue }}>why</span> it matters.
              </h1>
              <p style={{ fontSize: 17, color: C.textSec, lineHeight: 1.7, maxWidth: 580, margin: "0 auto 40px", fontWeight: 300 }}>
                Turn raw citation counts into grant-ready impact evidence. Discover high-profile scholars, top institutions, and venue quality — automatically.
              </p>
            </div>
            <div style={{ animation: "fadeUp 0.7s ease 0.15s both", display: "flex", gap: 10, maxWidth: 620, margin: "0 auto 14px" }}>
              <input value={query} onChange={e => setQuery(e.target.value)} onKeyDown={e => e.key === "Enter" && search()}
                placeholder="Paper title, DOI, arXiv ID, or Semantic Scholar URL…"
                style={{ flex: 1, padding: "15px 18px", background: C.surface, border: `1px solid ${C.border}`, borderRadius: 11, color: C.text, fontSize: 14, fontFamily: "'DM Sans', sans-serif", transition: "border-color 0.2s" }}
                onFocus={e => e.target.style.borderColor = C.accent} onBlur={e => e.target.style.borderColor = C.border} />
              <button onClick={search} disabled={searching}
                style={{ padding: "15px 28px", background: searching ? C.surfaceLight : `linear-gradient(135deg, ${C.accent}, #e8c84a)`, border: "none", borderRadius: 11, color: searching ? C.textMut : C.bg, fontSize: 14, fontWeight: 600, cursor: searching ? "wait" : "pointer", fontFamily: "'DM Sans', sans-serif" }}>
                {searching ? "Searching…" : "Search"}
              </button>
            </div>
            <p style={{ fontSize: 11, color: C.textMut, fontFamily: "'JetBrains Mono', monospace" }}>Try: "Attention Is All You Need" · 10.1038/s41586-021-03819-2 · 1706.03762</p>

            <div style={{ marginTop: 16, animation: "fadeUp 0.7s ease 0.25s both" }}>
              <button onClick={() => setShowKeyInput(!showKeyInput)}
                style={{ background: "transparent", border: "none", color: showKeyInput ? C.accent : C.textMut, fontSize: 12, cursor: "pointer", fontFamily: "'JetBrains Mono', monospace", padding: "4px 8px" }}>
                {apiKey ? "🔑 API key set ✓" : "🔑 Add S2 API key (optional — faster & more results)"}
              </button>
              {showKeyInput && (
                <div style={{ display: "flex", gap: 8, maxWidth: 480, margin: "10px auto 0", animation: "fadeIn 0.2s ease" }}>
                  <input
                    value={apiKey}
                    onChange={e => updateKey(e.target.value)}
                    placeholder="Paste your Semantic Scholar API key…"
                    type="password"
                    style={{ flex: 1, padding: "10px 14px", background: C.surface, border: `1px solid ${C.border}`, borderRadius: 8, color: C.text, fontSize: 12, fontFamily: "'JetBrains Mono', monospace" }}
                    onFocus={e => e.target.style.borderColor = C.accent} onBlur={e => e.target.style.borderColor = C.border} />
                  {apiKey && <button onClick={() => updateKey("")} style={{ padding: "10px 14px", background: C.surface, border: `1px solid ${C.border}`, borderRadius: 8, color: C.rose, fontSize: 11, cursor: "pointer" }}>Clear</button>}
                </div>
              )}
              {showKeyInput && !apiKey && (
                <p style={{ fontSize: 10, color: C.textMut, marginTop: 8, fontFamily: "'JetBrains Mono', monospace" }}>
                  Free at <a href="https://www.semanticscholar.org/product/api" target="_blank" rel="noopener noreferrer" style={{ color: C.blue }}>semanticscholar.org/product/api</a> — 10x faster, 20 author profiles instead of 10
                </p>
              )}
            </div>
            {err && <div style={{ marginTop: 16, padding: "10px 16px", background: "#fb718522", border: "1px solid #fb718544", borderRadius: 8, color: C.rose, fontSize: 13 }}>{err}</div>}
          </div>
          <div style={{ maxWidth: 900, margin: "20px auto 80px", padding: "0 36px", display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 14 }}>
            {[
              { i: "📋", t: "Grant Impact Summary", d: "Copy-ready statements for proposals" },
              { i: "🏆", t: "Highly-Cited Papers", d: "100+ citation papers citing YOUR work" },
              { i: "👥", t: "Scholar Profiles", d: "h-index & affiliations of citing authors" },
              { i: "🏛️", t: "Institutions", d: "Universities, industry labs & government" },
              { i: "📚", t: "Venue Quality", d: "Top journals & conferences ranked" },
              { i: "📈", t: "Citation Velocity", d: "Track impact trajectory over time" },
            ].map((f, i) => (
              <div key={i} style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 13, padding: "20px 18px", animation: `fadeUp 0.5s ease ${0.25 + i * 0.06}s both`, transition: "border-color 0.2s, transform 0.2s", cursor: "default" }}
                onMouseEnter={e => { e.currentTarget.style.borderColor = C.accent; e.currentTarget.style.transform = "translateY(-2px)"; }}
                onMouseLeave={e => { e.currentTarget.style.borderColor = C.border; e.currentTarget.style.transform = "translateY(0)"; }}>
                <div style={{ fontSize: 24, marginBottom: 10 }}>{f.i}</div>
                <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 4 }}>{f.t}</div>
                <div style={{ fontSize: 12, color: C.textSec, lineHeight: 1.4 }}>{f.d}</div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ======= SEARCH RESULTS ======= */}
      {view === "results" && (
        <div>
          <nav style={{ display: "flex", alignItems: "center", gap: 12, padding: "14px 28px", borderBottom: `1px solid ${C.border}`, position: "sticky", top: 0, zIndex: 100, background: `${C.bg}ee`, backdropFilter: "blur(12px)" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10, cursor: "pointer" }} onClick={() => { setView("landing"); setErr(""); }}>
              <div style={{ width: 28, height: 28, borderRadius: 7, background: `linear-gradient(135deg, ${C.accent}, ${C.blue})`, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 14, fontWeight: 700, color: C.bg }}>C</div>
              <span style={{ fontSize: 15, fontWeight: 700, fontFamily: "'Playfair Display', serif" }}>CitationImpact</span>
            </div>
            <div style={{ flex: 1, display: "flex", gap: 8, maxWidth: 480, marginLeft: 16 }}>
              <input value={query} onChange={e => setQuery(e.target.value)} onKeyDown={e => e.key === "Enter" && search()}
                style={{ flex: 1, padding: "9px 14px", background: C.surface, border: `1px solid ${C.border}`, borderRadius: 8, color: C.text, fontSize: 13, fontFamily: "'DM Sans', sans-serif" }}
                onFocus={e => e.target.style.borderColor = C.accent} onBlur={e => e.target.style.borderColor = C.border} />
              <button onClick={search} disabled={searching} style={{ padding: "9px 18px", background: C.accent, border: "none", borderRadius: 8, color: C.bg, fontSize: 13, fontWeight: 600, cursor: "pointer" }}>{searching ? "…" : "Search"}</button>
            </div>
          </nav>
          <div style={{ maxWidth: 780, margin: "28px auto", padding: "0 28px" }}>
            <h2 style={{ fontSize: 17, fontWeight: 600, marginBottom: 18, fontFamily: "'Playfair Display', serif", color: C.textSec }}>Select a paper to analyze <span style={{ fontSize: 13, color: C.textMut, fontWeight: 400 }}>({results.length} result{results.length !== 1 ? "s" : ""})</span></h2>
            {err && <div style={{ marginBottom: 14, padding: "10px 16px", background: "#fb718522", border: "1px solid #fb718544", borderRadius: 8, color: C.rose, fontSize: 13 }}>{err}</div>}
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {results.map((p, i) => (
                <div key={p.paperId || i} onClick={() => { setErr(""); analyze(p); }}
                  style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 12, padding: "18px 22px", cursor: "pointer", transition: "border-color 0.2s, transform 0.15s", animation: `fadeUp 0.4s ease ${i * 0.05}s both` }}
                  onMouseEnter={e => { e.currentTarget.style.borderColor = C.accent; e.currentTarget.style.transform = "translateY(-1px)"; }}
                  onMouseLeave={e => { e.currentTarget.style.borderColor = C.border; e.currentTarget.style.transform = "translateY(0)"; }}>
                  <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 6, lineHeight: 1.4 }}>{p.title || "Untitled"}</div>
                  <div style={{ display: "flex", gap: 14, fontSize: 12, color: C.textSec, flexWrap: "wrap", alignItems: "center" }}>
                    <span>{p.authors?.slice(0, 3).map(a => a.name).join(", ")}{p.authors?.length > 3 ? " et al." : ""}</span>
                    {p.year && <span style={{ color: C.textMut }}>· {p.year}</span>}
                    {p.venue && <span style={{ color: C.blue }}>· {p.venue}</span>}
                    <span style={{ color: C.accent, fontFamily: "'JetBrains Mono', monospace", fontWeight: 600 }}>{(p.citationCount || 0).toLocaleString()} citations</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* ======= ANALYZING ======= */}
      {view === "analyzing" && (
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", minHeight: "100vh", padding: 40, textAlign: "center" }}>
          <div style={{ width: 46, height: 46, borderRadius: 11, background: `linear-gradient(135deg, ${C.accent}, ${C.blue})`, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 21, fontWeight: 700, color: C.bg, marginBottom: 26 }}>C</div>
          <h2 style={{ fontSize: 21, fontWeight: 700, fontFamily: "'Playfair Display', serif", marginBottom: 8 }}>Analyzing Citations</h2>
          <p style={{ fontSize: 13, color: C.textSec, marginBottom: 30, maxWidth: 400, lineHeight: 1.5 }}>{paper?.title}</p>
          <div style={{ width: 380, maxWidth: "90%", marginBottom: 14 }}>
            <div style={{ width: "100%", height: 5, background: C.surface, borderRadius: 3, overflow: "hidden" }}>
              <div style={{ width: `${prog.pct}%`, height: "100%", background: `linear-gradient(90deg, ${C.accent}, ${C.blue})`, borderRadius: 3, transition: "width 0.4s ease" }} />
            </div>
          </div>
          <p style={{ fontSize: 12, color: C.textMut, fontFamily: "'JetBrains Mono', monospace", animation: "pulse 1.5s infinite" }}>{prog.msg}</p>
          {!_apiKey && <p style={{ fontSize: 10, color: C.textMut, marginTop: 12, fontFamily: "'JetBrains Mono', monospace" }}>⏱ Running in rate-limited mode (no API key) — this may take a few minutes</p>}
          <button onClick={() => { abort.current = true; setView("landing"); }}
            style={{ marginTop: 26, padding: "7px 18px", background: "transparent", border: `1px solid ${C.border}`, borderRadius: 7, color: C.textMut, fontSize: 12, cursor: "pointer" }}>Cancel</button>
        </div>
      )}

      {/* ======= DASHBOARD ======= */}
      {view === "dashboard" && data && (
        <div>
          <nav style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "11px 24px", borderBottom: `1px solid ${C.border}`, background: `${C.bg}ee`, backdropFilter: "blur(12px)", position: "sticky", top: 0, zIndex: 100 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10, cursor: "pointer" }} onClick={() => setView("landing")}>
              <div style={{ width: 26, height: 26, borderRadius: 6, background: `linear-gradient(135deg, ${C.accent}, ${C.blue})`, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 13, fontWeight: 700, color: C.bg }}>C</div>
              <span style={{ fontSize: 14, fontWeight: 700, fontFamily: "'Playfair Display', serif" }}>CitationImpact</span>
            </div>
            <div style={{ flex: 1, maxWidth: 400, margin: "0 14px", padding: "6px 12px", background: C.surface, borderRadius: 7, border: `1px solid ${C.border}`, fontSize: 11, color: C.textSec, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              <span style={{ color: C.accent, marginRight: 6 }}>⬡</span>{paper?.title}
            </div>
            <button onClick={() => setView("landing")} style={{ padding: "6px 14px", background: "transparent", border: `1px solid ${C.border}`, borderRadius: 6, color: C.textSec, fontSize: 11, cursor: "pointer" }}>← New Analysis</button>
          </nav>

          <div style={{ maxWidth: 1060, margin: "0 auto", padding: "24px 24px 80px" }}>
            {data.truncated && (
              <div style={{ marginBottom: 14, padding: "8px 14px", background: `${C.accent}11`, border: `1px solid ${C.accent}33`, borderRadius: 8, fontSize: 11, color: C.accent, fontFamily: "'JetBrains Mono', monospace" }}>
                ⚠ Paper has {data.totalCitationCount.toLocaleString()} total citations — analysis covers the first {data.totalCitations.toLocaleString()}.
              </div>
            )}

            <div style={{ display: "flex", gap: 3, marginBottom: 24, background: C.surface, borderRadius: 9, padding: 3, border: `1px solid ${C.border}`, width: "fit-content", flexWrap: "wrap" }}>
              {[["overview", "Overview"], ["papers", "Highly-Cited"], ["scholars", "Scholars"], ["institutions", "Institutions"], ["venues", "Venues"]].map(([id, label]) => (
                <button key={id} onClick={() => setTab(id)} style={{
                  padding: "8px 16px", background: tab === id ? C.surfaceLight : "transparent",
                  border: tab === id ? `1px solid ${C.border}` : "1px solid transparent",
                  borderRadius: 7, color: tab === id ? C.text : C.textMut, fontSize: 12, fontWeight: tab === id ? 600 : 400, cursor: "pointer", fontFamily: "'DM Sans', sans-serif"
                }}>{label}</button>
              ))}
            </div>

            {/* ---- OVERVIEW ---- */}
            {tab === "overview" && (
              <div style={{ animation: "fadeIn 0.3s" }}>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 12, marginBottom: 24 }}>
                  {[
                    { l: "Total Citations", v: data.totalCitationCount, i: "📊" },
                    { l: "Unique Authors", v: data.uniqueAuthors, i: "👥" },
                    { l: "100+ Cited", v: data.highlyCited.length, i: "🏆" },
                    { l: "Top Venues", v: data.venues.length, i: "📚" },
                  ].map((s, i) => (
                    <div key={i} style={{ background: `linear-gradient(135deg, ${C.surface}, ${C.surfaceLight})`, border: `1px solid ${C.border}`, borderRadius: 13, padding: "18px 20px", animation: `fadeUp 0.4s ease ${i * 0.05}s both` }}>
                      <div style={{ fontSize: 11, color: C.textMut, marginBottom: 5, fontFamily: "'JetBrains Mono', monospace", textTransform: "uppercase", letterSpacing: "0.05em" }}>{s.i} {s.l}</div>
                      <div style={{ fontSize: 30, fontWeight: 700, fontFamily: "'Playfair Display', serif" }}>{s.v.toLocaleString()}</div>
                    </div>
                  ))}
                </div>

                <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 13, padding: 22, marginBottom: 20 }}>
                  <Hdr sub="Copy-ready for your next proposal">📋 Grant Impact Summary</Hdr>
                  <div style={{ background: C.bg, borderRadius: 9, padding: 18, border: `1px solid ${C.border}`, position: "relative" }}>
                    <p style={{ fontSize: 13, lineHeight: 1.8, color: C.textSec, paddingRight: 60 }}>{summary}</p>
                    <button onClick={() => { navigator.clipboard?.writeText(summary); }}
                      style={{ position: "absolute", top: 10, right: 10, padding: "5px 11px", background: C.surfaceLight, border: `1px solid ${C.border}`, borderRadius: 5, color: C.textMut, fontSize: 10, cursor: "pointer", fontFamily: "'JetBrains Mono', monospace" }}>Copy ⎘</button>
                  </div>
                </div>

                <div style={{ display: "grid", gridTemplateColumns: data.sectors.length ? "5fr 3fr" : "1fr", gap: 16, marginBottom: 20 }}>
                  <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 13, padding: 22 }}>
                    <Hdr sub="Annual citations per year">📈 Citation Velocity</Hdr>
                    {data.timeline.length > 1 ? (
                      <ResponsiveContainer width="100%" height={220}>
                        <AreaChart data={data.timeline}>
                          <defs><linearGradient id="ag" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor={C.blue} stopOpacity={0.3} /><stop offset="100%" stopColor={C.blue} stopOpacity={0} /></linearGradient></defs>
                          <XAxis dataKey="year" tick={{ fill: C.textMut, fontSize: 11, fontFamily: "'JetBrains Mono', monospace" }} axisLine={{ stroke: C.border }} tickLine={false} />
                          <YAxis tick={{ fill: C.textMut, fontSize: 11 }} axisLine={false} tickLine={false} />
                          <Tooltip content={<TT />} />
                          <Area type="monotone" dataKey="annual" stroke={C.blue} strokeWidth={2} fill="url(#ag)" dot={{ fill: C.blue, r: 3, strokeWidth: 0 }} name="Annual Citations" />
                        </AreaChart>
                      </ResponsiveContainer>
                    ) : <p style={{ color: C.textMut, fontSize: 13, padding: 20 }}>Not enough yearly data to plot.</p>}
                  </div>

                  {data.sectors.length > 0 && (
                    <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 13, padding: 22 }}>
                      <Hdr sub="From top citing authors">🏛️ Sector</Hdr>
                      <ResponsiveContainer width="100%" height={150}>
                        <PieChart><Pie data={data.sectors} cx="50%" cy="50%" innerRadius={38} outerRadius={62} paddingAngle={3} dataKey="value" stroke="none">
                          {data.sectors.map((_, i) => <Cell key={i} fill={PIE_C[i % PIE_C.length]} />)}
                        </Pie><Tooltip content={<TT />} /></PieChart>
                      </ResponsiveContainer>
                      <div style={{ display: "flex", flexWrap: "wrap", gap: 10, justifyContent: "center", marginTop: 4 }}>
                        {data.sectors.map((s, i) => (
                          <div key={i} style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 11, color: C.textSec }}>
                            <div style={{ width: 7, height: 7, borderRadius: 2, background: PIE_C[i % PIE_C.length] }} />{s.name} ({s.value})
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>

                {data.venues.length > 0 && (
                  <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 13, padding: 22 }}>
                    <Hdr sub="Most frequent citation venues">📚 Top Venues</Hdr>
                    <ResponsiveContainer width="100%" height={Math.max(180, data.venues.slice(0, 10).length * 30)}>
                      <BarChart data={data.venues.slice(0, 10)} layout="vertical" margin={{ left: 8 }}>
                        <XAxis type="number" tick={{ fill: C.textMut, fontSize: 11 }} axisLine={false} tickLine={false} />
                        <YAxis type="category" dataKey="name" tick={{ fill: C.textSec, fontSize: 11 }} axisLine={false} tickLine={false} width={200} />
                        <Tooltip content={<TT />} />
                        <Bar dataKey="count" name="Citing Papers" radius={[0, 5, 5, 0]} barSize={15} fill={C.blue} />
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                )}
              </div>
            )}

            {/* ---- HIGHLY CITED ---- */}
            {tab === "papers" && (
              <div style={{ animation: "fadeIn 0.3s" }}>
                <Hdr sub={`${data.highlyCited.length} papers with 100+ citations that cite this work`}>🏆 Highly-Cited Citing Papers</Hdr>
                {data.highlyCited.length === 0 ? (
                  <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 12, padding: 32, textAlign: "center", color: C.textMut, fontSize: 13 }}>No citing papers with 100+ citations found.</div>
                ) : data.highlyCited.map((p, i) => (
                  <div key={i} style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 12, padding: "16px 20px", marginBottom: 10, display: "flex", justifyContent: "space-between", alignItems: "center", animation: `fadeUp 0.4s ease ${i * 0.03}s both`, transition: "border-color 0.2s" }}
                    onMouseEnter={e => e.currentTarget.style.borderColor = C.accent} onMouseLeave={e => e.currentTarget.style.borderColor = C.border}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 5, lineHeight: 1.4 }}>
                        {p.url ? <a href={p.url} target="_blank" rel="noopener noreferrer">{p.title || "Untitled"}</a> : (p.title || "Untitled")}
                      </div>
                      <div style={{ fontSize: 12, color: C.textSec, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {p.authors?.slice(0, 3).map(a => a.name).join(", ")}{p.authors?.length > 3 ? " et al." : ""}
                        {p.year ? ` · ${p.year}` : ""}{p.venue ? <span style={{ color: C.blue }}> · {p.venue}</span> : ""}
                      </div>
                    </div>
                    <div style={{ textAlign: "right", marginLeft: 14, flexShrink: 0 }}>
                      <div style={{ fontSize: 22, fontWeight: 700, color: C.accent, fontFamily: "'Playfair Display', serif" }}>{(p.citationCount || 0).toLocaleString()}</div>
                      <div style={{ fontSize: 9, color: C.textMut, fontFamily: "'JetBrains Mono', monospace" }}>CITATIONS</div>
                    </div>
                  </div>
                ))}
              </div>
            )}

            {/* ---- SCHOLARS ---- */}
            {tab === "scholars" && (
              <div style={{ animation: "fadeIn 0.3s" }}>
                <Hdr sub="Top citing authors by h-index (enriched via Semantic Scholar)">👥 High-Profile Scholars</Hdr>
                {data.scholars.length === 0 ? (
                  <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 12, padding: 32, textAlign: "center", color: C.textMut, fontSize: 13 }}>No enriched author profiles available.</div>
                ) : (
                  <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 12, overflow: "auto" }}>
                    <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 680 }}>
                      <thead><tr style={{ borderBottom: `1px solid ${C.border}` }}>
                        {["Scholar", "h-index", "Total Citations", "Affiliation", "Papers Citing"].map(h => (
                          <th key={h} style={{ padding: "11px 14px", textAlign: "left", fontSize: 10, color: C.textMut, fontFamily: "'JetBrains Mono', monospace", textTransform: "uppercase", letterSpacing: "0.06em", fontWeight: 500 }}>{h}</th>
                        ))}
                      </tr></thead>
                      <tbody>{data.scholars.map((s, i) => (
                        <tr key={i} style={{ borderBottom: `1px solid ${C.border}`, transition: "background 0.15s" }}
                          onMouseEnter={e => e.currentTarget.style.background = C.surfaceLight} onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
                          <td style={{ padding: "13px 14px" }}>
                            {s.url ? <a href={s.url} target="_blank" rel="noopener noreferrer" style={{ fontSize: 13, fontWeight: 600 }}>{s.name}</a>
                              : <span style={{ fontSize: 13, fontWeight: 600, color: C.blue }}>{s.name}</span>}
                          </td>
                          <td style={{ padding: "13px 14px" }}><span style={{ background: C.accentDim, color: C.accent, padding: "3px 8px", borderRadius: 5, fontSize: 12, fontWeight: 600, fontFamily: "'JetBrains Mono', monospace" }}>{s.hIndex}</span></td>
                          <td style={{ padding: "13px 14px", fontSize: 12, color: C.textSec, fontFamily: "'JetBrains Mono', monospace" }}>{(s.citationCount || 0).toLocaleString()}</td>
                          <td style={{ padding: "13px 14px", fontSize: 12, color: C.textSec, maxWidth: 200, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{s.affiliations?.[0] || "—"}</td>
                          <td style={{ padding: "13px 14px", fontSize: 13, fontWeight: 600, color: C.emerald }}>{s.citingCount}</td>
                        </tr>
                      ))}</tbody>
                    </table>
                  </div>
                )}
              </div>
            )}

            {/* ---- INSTITUTIONS ---- */}
            {tab === "institutions" && (
              <div style={{ animation: "fadeIn 0.3s" }}>
                <Hdr sub="Aggregated from top citing author affiliations">🏛️ Citing Institutions</Hdr>
                {data.institutions.length === 0 ? (
                  <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 12, padding: 32, textAlign: "center", color: C.textMut, fontSize: 13 }}>No institution data available.</div>
                ) : (
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 10 }}>
                    {data.institutions.map((inst, i) => {
                      const sc = inst.sector === "University" ? C.blue : inst.sector === "Industry" ? C.accent : inst.sector === "Medical" ? C.rose : C.emerald;
                      return (
                        <div key={i} style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 12, padding: "16px 18px", display: "flex", justifyContent: "space-between", alignItems: "center", animation: `fadeUp 0.4s ease ${i * 0.04}s both` }}>
                          <div style={{ minWidth: 0, flex: 1 }}>
                            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 3 }}>
                              <span style={{ fontSize: 13, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{inst.name}</span>
                              <span style={{ padding: "2px 6px", borderRadius: 3, fontSize: 9, fontWeight: 600, fontFamily: "'JetBrains Mono', monospace", background: `${sc}22`, color: sc, flexShrink: 0 }}>{inst.sector.toUpperCase()}</span>
                            </div>
                          </div>
                          <div style={{ textAlign: "right", flexShrink: 0, marginLeft: 12 }}>
                            <div style={{ fontSize: 20, fontWeight: 700, fontFamily: "'Playfair Display', serif" }}>{inst.count}</div>
                            <div style={{ fontSize: 9, color: C.textMut, fontFamily: "'JetBrains Mono', monospace" }}>PAPERS</div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            )}

            {/* ---- VENUES ---- */}
            {tab === "venues" && (
              <div style={{ animation: "fadeIn 0.3s" }}>
                <Hdr sub="All venues where citing papers were published">📚 Citation Venues</Hdr>
                {data.venues.length === 0 ? (
                  <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 12, padding: 32, textAlign: "center", color: C.textMut, fontSize: 13 }}>No venue data available.</div>
                ) : (
                  <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 12, overflow: "auto" }}>
                    <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 400 }}>
                      <thead><tr style={{ borderBottom: `1px solid ${C.border}` }}>
                        {["Venue", "Citing Papers"].map(h => (
                          <th key={h} style={{ padding: "11px 14px", textAlign: "left", fontSize: 10, color: C.textMut, fontFamily: "'JetBrains Mono', monospace", textTransform: "uppercase", letterSpacing: "0.06em", fontWeight: 500 }}>{h}</th>
                        ))}
                      </tr></thead>
                      <tbody>{data.venues.map((v, i) => (
                        <tr key={i} style={{ borderBottom: `1px solid ${C.border}`, transition: "background 0.15s" }}
                          onMouseEnter={e => e.currentTarget.style.background = C.surfaceLight} onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
                          <td style={{ padding: "13px 14px", fontSize: 13, fontWeight: 500 }}>{v.name}</td>
                          <td style={{ padding: "13px 14px" }}>
                            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                              <div style={{ width: Math.max(4, Math.min(180, (v.count / data.venues[0].count) * 180)), height: 5, background: C.blue, borderRadius: 3 }} />
                              <span style={{ fontSize: 12, fontWeight: 600, color: C.accent, fontFamily: "'JetBrains Mono', monospace" }}>{v.count}</span>
                            </div>
                          </td>
                        </tr>
                      ))}</tbody>
                    </table>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
