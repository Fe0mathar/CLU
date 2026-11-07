/**
 * Q3 — what the four gauges show, and what they show when a signal is absent.
 *
 * `DEV-P1-16`. This is `deriveTelemetry`, lifted verbatim from `app.js` where it sat inside a
 * 6000-line IIFE and could not be called by anything but the canvas that drew its output. Nothing
 * about the decisions has changed; what has changed is that they can now be asked questions.
 *
 * ## Why this function and not the canvas
 *
 * The drawing is large and its acceptance is visual — a session cannot execute a browser, so
 * extracting it would move code without adding proof. This function is the opposite: 129 lines of
 * pure decision about what each area *means*, including every honest-absence rule the quadrant
 * has, and none of it was reachable by a test.
 *
 * The comment the original carried on area D is the reason it was worth extracting first:
 *
 * > honest 'unknown' (flatline) where a signal is genuinely absent, never a fabricated pulse.
 *
 * That rule is the same one the Status Contract spends its length on and that
 * `components/branchPresentation.js` enforces one panel over. Here it was a comment above a
 * calculation, holding only for as long as everyone editing the calculation kept reading the
 * comment. It is now `selftest`-able, and the tests state it as a requirement.
 *
 * ## One impure dependency, taken as a parameter
 *
 * `excludedMeasureIds()` reads `window.__q2Field` and `localStorage`. Passing the resulting Set in
 * makes this function total: same snapshot and same exclusions, same output, no globals. That is
 * what lets a test ask what happens when every measured improvement is excluded — a real state
 * with its own status string, and one nobody could previously reach without a browser.
 */

const fin3 = (v) => Number.isFinite(v);
const clamp3 = (v, a, b) => (v < a ? a : v > b ? b : v);
const fmtK = (n) => {
  if (!fin3(n)) return '\u2014';
  const a = Math.abs(n);
  if (a >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (a >= 1e4) return (n / 1e3).toFixed(1) + 'k';
  return String(Math.round(n));
};

/**
 * Turns one sealed frame snapshot into the four gauge areas.
 *
 * @param {unknown} snapshot the console frame's snapshot
 * @param {Set<string>} [excluded] measurement ids the operator excluded from this cycle
 * @returns {{ai: object|null, cycle: object|null, gain: object|null, health: object|null}}
 *   An area is `null` when the snapshot carries nothing for it. Null is the flatline: the gauge
 *   has no reading, which is different from a reading of zero.
 */
export function deriveTelemetry(snapshot, excluded = new Set()) {
  const d = (snapshot && snapshot.dashboard) || {};
  const out = { ai:null, cycle:null, gain:null, health:null };

  /* A · AI utilization */
  const calls = (d.sessions && d.sessions.calls) || (d.crown && d.crown.calls) || null;
  const scount = (d.sessions && d.sessions.counts) || (d.crown && d.crown.sessions) || null;
  if (calls) {
    const limit = Number(calls.limit ?? 0), remaining = Number(calls.remaining ?? 0);
    const used = limit > 0 ? clamp3(((limit - remaining) / limit) * 100, 0, 100) : null;
    const burn = Number(calls.burnRatePerHour ?? 0);
    const anyActivity = (calls.thisCycle|0) > 0 || (calls.inFlight|0) > 0 || burn > 0 || (calls.today|0) > 0;
    out.ai = {
      value: used != null ? used : (anyActivity ? clamp3(Math.log10(1+burn)*33,0,100) : null),
      big: fmtK(calls.thisCycle ?? calls.today ?? 0), bigUnit: 'calls',
      status: anyActivity ? 'LIVE' : 'STANDBY',
      warn: anyActivity ? null : 'AI gateway offline until Stage D2 — deterministic stages running',
      lines: [
        ['burn', fmtK(burn)+'/h'], ['in-flight', fmtK(calls.inFlight??0)],
        ['cache-avoided', fmtK(calls.avoidedByCache??0)], ['remaining', limit>0?fmtK(remaining):'∞'],
        ['sessions', scount?`${scount.active??0}/${scount.limit??0}`:'—']
      ],
      raw: { successful:Number(calls.successful||0), retries:Number(calls.retries||0), cache:Number(calls.avoidedByCache||0),
             failed:Number(calls.failed||0)+Number(calls.discarded||0), inFlight:Number(calls.inFlight||0),
             queued:Number(calls.queued||0), thisCycle:Number(calls.thisCycle||0), burn }
    };
  }

  /* B · cycle progress */
  const p = d.progress || null;
  if (p) {
    const phases = ['recognition','deep_review','proven_improvement','certification','test_maturity'];
    const vals = phases.map(k => clamp3(Number(p[k] ?? 0), 0, 100));
    const overall = vals.reduce((a,b)=>a+b,0) / phases.length;
    const done = vals.filter(v=>v>=100).length;
    const nextTxt = (d.lens && d.lens.next && d.lens.next.summary) || null;
    out.cycle = {
      value: overall, big: String(Math.round(overall)), bigUnit: '%',
      status: overall>=100 ? 'COMPLETE' : (overall>0 ? 'IN CYCLE' : 'IDLE'),
      warn: null,
      lines: [
        ['cycle #', String((d.crown && d.crown.cycle) ?? 0)], ['phases done', `${done}/5`],
        ['recognition', Math.round(vals[0])+'%'], ['certification', Math.round(vals[3])+'%'],
        ['next', nextTxt ? String(nextTxt).slice(0,26) : '—']
      ],
      raw: { phases: phases.map((k,idx)=>({ key:k, value:vals[idx] })), cycleNum: Number((d.crown && d.crown.cycle) ?? 0), next: nextTxt, done }
    };
  }

  /* C · overall improvement (from the Q2 field) */
  const iv = d.improvementField || null;
  if (iv && Array.isArray(iv.cells)) {
          const measured = iv.cells.filter(c => (c.state==='available'||c.state==='stale') && c.netContribution!=null);
    const act = measured.filter(c => !excluded.has(String(c.measurementId ?? '')));
    const excludedMeasured = measured.length - act.length;
    if (act.length) {
      const net = act.reduce((s,c)=>s+(c.netContribution||0),0);
      const mean = clamp3(net/act.length, -100, 100);
      const best = act.slice().sort((a,b)=>(b.netContribution||0)-(a.netContribution||0))[0];
      const contribs = act.reduce((s,c)=>s+(c.contributionCount||((c.segments||[]).length)),0);
      out.gain = {
        value: mean, big: (net>=0?'+':'')+fmtK(net), bigUnit: 'net',
        status: net>=0 ? 'GAINING' : 'REGRESSING', warn: null,
        lines: [
          ['measures', String(act.length)], ['contributions', String(contribs)],
          ['excluded', String(excludedMeasured)],
          ['mean/measure', (mean>=0?'+':'')+mean.toFixed(1)],
          ['best', best ? `${best.measurementId} ${(best.netContribution>=0?'+':'')}${Math.round(best.netContribution)}` : '—'],
          ['mode', String(iv.aggregationMode||'—').replace(/_/g,' ').toLowerCase()]
        ]
      };
      const _cells=act.map(c=>({id:c.measurementId,net:c.netContribution,col:c.familyColor||'#39ff88'}));
      const _um={};
      for(const c of act){ for(const sg of (c.segments||[])){ if(sg&&!sg.invalidated&&sg.native&&typeof sg.native.delta==='number'&&sg.native.unit){
        const u=sg.native.unit; (_um[u]||(_um[u]={unit:u,delta:0,n:0,norm:0})); _um[u].delta+=sg.native.delta; _um[u].n++; _um[u].norm+=(sg.normalizedContribution||0); } } }
      out.gain.raw={ cells:_cells, units:Object.values(_um).sort((x,y)=>y.n-x.n).slice(0,4).map(u=>({unit:u.unit,delta:u.delta,n:u.n,up:u.norm>=0})), net, count:contribs, excluded:excludedMeasured };
    } else {
      const excludedOnly = excludedMeasured > 0;
      out.gain = { value:null, big:'—', bigUnit:'net', status:excludedOnly ? 'ALL EXCLUDED' : 'AWAITING PROOF',
        warn:excludedOnly ? 'all measured improvements are excluded from this cycle' : 'no proven improvements recorded yet — the dial moves only on evidence', lines:[['measures','0'],['excluded',String(excludedMeasured)],['contributions','0']] };
    }
  }

  /* D · CLU-E health — per-subsystem vitals; honest 'unknown' (flatline) where a
   * signal is genuinely absent, never a fabricated pulse. */
  {
    const sc = (d.sessions && d.sessions.counts) || null;
    const oc = d.operationalConsole || null;
    const stages = (d.pipeline && d.pipeline.stages) || [];
    const hasSeal = !!(snapshot && snapshot.seal);
    const sealOk = !(snapshot && snapshot.seal && snapshot.seal.consistent === false);
    const dropped = oc ? Number(oc.droppedEvents ?? 0) : 0;
    const failed = stages.filter(s=>s && s.state==='failed').length;
    const running = stages.some(s=>s && s.state==='running');
    const custBad = sc ? ((sc.failed|0)>0 || (sc.recoveryRequired|0)>0) : false;
    const sealStatus = !hasSeal ? 'unknown' : (sealOk ? 'ok' : 'crit');
    const pipeStatus = stages.length ? (failed ? 'crit' : 'ok') : 'unknown';
    const evidStatus = oc ? (dropped>0 ? 'warn' : 'ok') : 'unknown';
    const custStatus = sc ? (custBad ? 'warn' : 'ok') : 'unknown';
    let score = 100; const notes = [];
    if (sealStatus==='crit') { score -= 40; notes.push('seal inconsistent'); }
    if (failed) { score -= 25*Math.min(2,failed); notes.push(`${failed} stage(s) failed`); }
    if (dropped>0) { score -= 10; notes.push(`${dropped} console events dropped`); }
    if (custBad) { score -= 15; notes.push('session recovery required'); }
    const known = [sealStatus,pipeStatus,evidStatus,custStatus].filter(x=>x!=='unknown').length;
    score = clamp3(score, 0, 100);
    out.health = {
      value: known ? score : null,
      big: known ? String(Math.round(score)) : '—', bigUnit: '',
      status: !known ? 'NO SIGNAL' : score>=80 ? 'NOMINAL' : score>=50 ? 'DEGRADED' : 'CRITICAL',
      warn: notes.length ? notes.join(' · ') : null,
      lines: [
        ['state seal', sealStatus==='unknown'?'—':(sealOk?'consistent':'BROKEN')],
        ['pipeline', stages.length?(failed?`${failed} failed`:(running?'running':'idle')):'—'],
        ['events dropped', oc?String(dropped):'—'],
        ['sessions', sc?`${sc.active??0} active${custBad?' · recovery':''}`:'—'],
        ['uptime', fmtK((d.crown&&d.crown.uptime)||0)+'s']
      ],
      raw: { vitals: [
        {key:'seal',label:'SEAL',status:sealStatus},
        {key:'pipe',label:'PIPE',status:pipeStatus},
        {key:'evid',label:'EVID',status:evidStatus},
        {key:'cust',label:'CUST',status:custStatus}
      ], score: known? score : null, known, metrics: { dropped, failed, running, sessionsActive: sc? (sc.active??0): null } }
    };
  }
  return out;
}
