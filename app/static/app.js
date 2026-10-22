'use strict';
const $ = (selector) => document.querySelector(selector);
const escapeHTML = (value) => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const icons = {
  patient: '<circle cx="12" cy="8" r="3"/><path d="M5 21v-3a7 7 0 0 1 14 0v3"/>',
  lab: '<path d="M9 3h6M10 3v7L4 19a1.5 1.5 0 0 0 1.3 2h13.4a1.5 1.5 0 0 0 1.3-2l-6-9V3M7 15h10"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  file: '<path d="M14 3H5v18h14V8zM14 3v5h5M8 12h8M8 16h6"/>',
  lock: '<rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3M12 14v3"/>',
  chat: '<path d="M21 11a8 8 0 0 1-8 8H7l-5 3 2-6a8 8 0 0 1-1-5 9 9 0 0 1 18 0ZM7 10h10M7 14h6"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
};
const icon = name => `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true">${icons[name] || icons.file}</svg>`;
const arrow = '<span class="arrow" aria-hidden="true">→</span>';
const params = new URLSearchParams(location.search);
const studyId = location.pathname.startsWith('/study/') ? decodeURIComponent(location.pathname.split('/')[2]) : params.get('study');
const storeKey = `clinical-study:${studyId || 'local-preview'}`;
let config = null, session = null, caseData = null, token = '', error = '', busy = false, tab = 'patient';
let receipt = null, pollTimer = null, pendingRequest = null;
let draft = {question:'',tests:[],diagnosis:'',confidence:50}, draftKey = '';
let formDraft = {}, inclusion = null, consent = false;

function persist() { sessionStorage.setItem(storeKey, JSON.stringify({id:session.id,token})); }
function saveDraft() { if (draftKey) sessionStorage.setItem(draftKey, JSON.stringify(draft)); }
function loadDraft() {
  const key = `${storeKey}:${session.id}:${session.step?.id}`;
  if (key === draftKey) return;
  draftKey = key;
  try { draft = JSON.parse(sessionStorage.getItem(key)) || {question:'',tests:[],diagnosis:'',confidence:50}; }
  catch { draft = {question:'',tests:[],diagnosis:'',confidence:50}; }
  tab = 'patient';
}
async function api(path, body) {
  const headers = {Accept:'application/json'};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  let response;
  try { response = await fetch(path, {method:body === undefined ? 'GET' : 'POST',headers,body:body === undefined ? undefined : JSON.stringify(body)}); }
  catch { throw new Error('The server could not be reached. Your saved work is kept in this tab. Check your connection and try again.'); }
  const data = await response.json();
  if (!response.ok) {
    const messages = {401:'This session could not be authenticated. Keep this tab open and contact the study team.',
      403:'This action is not available from this page.',404:'This study is not available. Open your study link from Prolific.',
      409:'The session has changed or this action is not available. Your latest progress has been reloaded; review it before trying again.',
      422:'Please check the required fields before continuing.',503:'The study service is temporarily unavailable. Please try again shortly.'};
    const e = new Error(messages[response.status] || 'Something went wrong while saving. Your draft is kept here. Please try again.');
    e.status = response.status;
    if (response.status === 422 && data.detail === 'This study is for qualified medical doctors') e.message = 'This study is for qualified medical doctors. If you are not eligible, return to Prolific and contact the study team.';
    throw e;
  }
  return data;
}
async function act(work) {
  if (busy) return;
  busy = true; error = ''; render();
  try { await work(); }
  catch (e) {
    error = e.message;
    if (e.status === 409 && session) { try { await refresh(); } catch {} }
  }
  finally { busy = false; render(); if (error) $('#error')?.focus(); }
}
function idempotent(kind, payload) {
  const signature = JSON.stringify({kind,payload});
  if (pendingRequest?.signature !== signature) pendingRequest = {signature,id:crypto.randomUUID()};
  return {...payload,request_id:pendingRequest.id};
}
async function refresh() {
  session = await api(`/v1/sessions/${session.id}`);
  persist();
  await loadCase();
}
async function loadCase() {
  clearTimeout(pollTimer);
  if (session?.step?.kind === 'diagnosis') {
    caseData = await api(`/v1/sessions/${session.id}/cases/${session.step.id}`);
    loadDraft();
    if (caseData.pending) schedulePoll();
  } else caseData = null;
}
function schedulePoll() {
  clearTimeout(pollTimer);
  const currentStep = session.step.id;
  pollTimer = setTimeout(async () => {
    if (session?.step?.id !== currentStep || busy) { if (caseData?.pending) schedulePoll(); return; }
    try {
      const next = await api(`/v1/sessions/${session.id}/cases/${currentStep}`);
      const changed = JSON.stringify(next) !== JSON.stringify(caseData);
      caseData = next;
      if (changed) render();
      if (next.pending) schedulePoll();
      else $('#announcer').textContent = next.rounds_used>=3 ? 'All three rounds are complete. Please submit your diagnosis.' : 'The response is ready. You may ask another question or submit a diagnosis.';
    } catch (e) { error = e.message; render(); schedulePoll(); }
  }, 2000);
}
function stageNumber() {
  if (!session) return 0;
  if (session.status === 'completed' || session.step?.kind === 'final_check') return 3;
  return session.step?.kind === 'diagnosis' || receipt ? 2 : 1;
}
function shell(content) {
  const active = stageNumber();
  const labels = ['Welcome','About you','Case review','Finish'];
  return `<header class="topbar"><div class="brand"><img src="/assets/mark.svg" width="40" height="40" alt="" class="brand-mark"><div><div class="brand-name">Clinical Reasoning Study</div><div class="brand-sub">Interactive diagnostic research</div></div></div>
    <div class="header-right">${config?.is_demo || session?.is_demo ? '<span class="badge">Development preview</span>' : ''}<span class="saved"><span class="dot"></span>${busy ? 'Saving…' : session ? 'Progress saved' : 'Participant portal'}</span><button class="help" data-action="help" aria-label="Open study guide">?</button></div></header>
    <nav class="stepbar" aria-label="Study progress">${labels.map((label,i) => `${i ? '<span class="stage-line"></span>':''}<div class="stage ${i === active ? 'current' : i < active ? 'done' : ''}" ${i === active ? 'aria-current="step"':''}><b>${i < active ? '✓':i+1}</b><span>${label}</span></div>`).join('')}</nav>
    <div class="wrap">${error ? `<div class="error" id="error" role="alert" tabindex="-1"><button data-action="dismiss-error" aria-label="Dismiss message">×</button>${escapeHTML(error)}</div>`:''}<main id="main">${content}</main></div>
    <footer class="footer"><span>Clinical Reasoning Study <span aria-hidden="true">·</span> ${session?.is_demo || config?.is_demo ? 'Synthetic cases · Development preview' : 'Research participation'}</span><span>For research only. Do not enter real patient information.</span><button data-action="help">Study guide ↗</button></footer>`;
}
function welcome() {
  if (!config) return `<section class="center-page"><div class="card"><span class="eyebrow">Participant portal</span><h1>Open your study invitation.</h1><p class="intro-text">Please use the study link supplied through Prolific to join your assigned session.</p><button class="btn secondary" data-action="reload">Try again ${arrow}</button></div></section>`;
  const demo = config.is_demo;
  const poolSize = demo ? 150 : config.pool_size;
  const sources = demo ? ['MedQA','NEJM','MediQ'] : config.sources || [];
  return `<section class="welcome"><div class="hero"><div><span class="eyebrow">A study for medical doctors</span><h1>Every question<br>shapes a <em>diagnosis.</em></h1><p>Review a clinical case, gather the information you need and make your diagnosis. Your reasoning starts with the questions you choose.</p><div class="hero-note">${icon('clock')} ${config.cases_per_participant} cases in this session <span aria-hidden="true">·</span> Up to 3 question rounds per case</div></div>
    <aside class="protocol" aria-label="Study procedure"><div class="protocol-top"><span class="eyebrow">Your path through each case</span><span class="protocol-count">01 → 03</span></div>
    <div class="protocol-row"><div class="protocol-icon">${icon('file')}</div><div><h3>Review the presentation</h3><p>Start with a brief clinical vignette.</p></div></div>
    <div class="protocol-row"><div class="protocol-icon">${icon('chat')}</div><div><h3>Ask. Investigate. Reconsider.</h3><p>Question the patient or request laboratory findings in up to three rounds.</p></div></div>
    <div class="protocol-row"><div class="protocol-icon">${icon('check')}</div><div><h3>Commit to your diagnosis</h3><p>Submit when confident, or after round three.</p></div></div></aside></div>
    <div class="pool-bar"><div class="pool-info"><span class="pool-number">${poolSize}</span><span>${demo ? 'Planned case pool' : 'Study case pool'}<br><small>${demo ? 'Dataset upload pending · this preview uses 3 fictional cases' : 'Each participant is assigned a subset'}</small></span></div><div class="sources" aria-label="${demo?'Planned dataset sources':'Dataset sources'}">${sources.map(source=>`<span>${escapeHTML(source)}</span>`).join('')}</div></div>
    <div class="card consent-card"><div><h2>Before you begin</h2><p>${demo ? 'Explore the participant experience with three fictional cases. This preview does not submit anything to Prolific.' : 'Please read the study information before choosing whether to participate. Your answers will be saved as you progress.'}</p><details><summary>Read the study information & consent</summary><p>${escapeHTML(config.consent_text)}</p></details></div><div class="consent-actions"><label class="check"><input id="consent" type="checkbox" ${consent?'checked':''}> <span>I have read the study information and ${demo ? 'agree to start this development preview' : 'consent to participate in this study'}.</span></label><button class="btn block" data-action="start" ${!consent || busy?'disabled':''}>${busy ? 'Starting…' : demo ? 'Start demo session' : 'Begin study'} ${arrow}</button></div></div></section>`;
}
function background() {
  const step = session.step;
  return `<section class="center-page"><div class="card"><span class="eyebrow">Before the first case</span><h1>${escapeHTML(step.title)}</h1><p class="intro-text">${escapeHTML(step.instructions || 'Please complete the following before continuing.')}</p><form id="background-form">${step.questions.map(q => {
    const value = formDraft[q.id] ?? '';
    const input = q.kind === 'boolean' ? `<label class="check"><input name="${escapeHTML(q.id)}" type="checkbox" ${value?'checked':''} ${q.required?'required':''}><span>${escapeHTML(q.label)}</span></label>` :
      `<label for="field-${escapeHTML(q.id)}">${escapeHTML(q.label)}</label>${q.kind === 'choice' ? `<select class="input" id="field-${escapeHTML(q.id)}" name="${escapeHTML(q.id)}" ${q.required?'required':''}><option value="">Select an option</option>${q.options.map(o=>`<option ${value===o?'selected':''}>${escapeHTML(o)}</option>`).join('')}</select>` : `<input class="input" id="field-${escapeHTML(q.id)}" name="${escapeHTML(q.id)}" type="${q.kind==='number'?'number':'text'}" value="${escapeHTML(value)}" ${q.required?'required':''} ${q.minimum != null?`min="${q.minimum}"`:''} ${q.maximum != null?`max="${q.maximum}"`:''} maxlength="6000">`}`;
    return `<div class="form-row">${input}</div>`;
  }).join('')}<div class="form-actions"><small>${session.is_demo ? 'Preview: background information is saved locally on the study server.' : 'Medical qualification is self-reported here; recruitment eligibility is handled through Prolific.'}</small><button class="btn" type="submit" ${busy?'disabled':''}>Continue to cases ${arrow}</button></div></form></div></section>`;
}
function sidebar() {
  return `<aside class="sidebar" aria-label="Session cases"><div><div class="eyebrow">Your session</div><div class="session-stat">${session.completed_cases} <span>/ ${session.total_cases} cases</span></div><progress class="progress" max="${session.total_cases}" value="${session.completed_cases}" aria-label="Completed cases"></progress></div><ol class="case-list">${Array.from({length:session.total_cases},(_,i)=>`<li class="${i<session.completed_cases?'done':i===session.completed_cases?'active':''}" ${i===session.completed_cases?'aria-current="step"':''}><span>${i<session.completed_cases?'✓':String(i+1).padStart(2,'0')}</span>Case ${String(i+1).padStart(2,'0')}</li>`).join('')}</ol><div class="side-note">${icon('chat')}<strong>Follow your clinical reasoning.</strong>Use the rounds you need. You can submit a diagnosis at any point before the third round.</div></aside>`;
}
function turns() {
  return caseData.turns.map(t=>`<article class="turn"><div class="turn-question"><div class="turn-meta">Round ${t.round_number} <span aria-hidden="true">·</span> You → ${t.target==='patient'?'Patient':'Laboratory'}</div>${escapeHTML(t.question || t.tests.join(', '))}</div><div class="turn-answer">${t.status==='succeeded'?`<div class="turn-meta">${t.target==='patient'?'Patient response':'Laboratory findings'}</div>${escapeHTML(t.response)}` : ['queued','running'].includes(t.status)?`<div class="pending"><span class="spinner"></span>${t.status==='queued'?'Your request is queued…':'Preparing the response…'}</div>` : '<div class="muted">The response could not be completed. This request did not use a round. You can submit a new request or diagnose using the information available.</div>'}</div></article>`).join('');
}
function questionComposer() {
  if (caseData.pending) return `<div class="round-finished">${icon('clock')}<div><strong>Waiting for your response</strong>You can draft your diagnosis while the agent responds. The request is saved; you may reload this page.</div></div>`;
  if (!caseData.can_ask) return `<div class="round-finished">${icon('check')}<div><strong>${caseData.rounds_used>=3 ? 'All three rounds are complete.' : 'No further requests are available.'}</strong>${caseData.rounds_used>=3 ? 'Review the information and submit your final diagnosis.' : 'After repeated response failures, please submit your best diagnosis using the information available. Failures are recorded for the study team.'}</div></div>`;
  return `<div class="card composer"><div class="tabs" role="tablist" aria-label="Question recipient"><button id="patient-tab" class="tab" role="tab" aria-controls="question-panel" aria-selected="${tab==='patient'}" data-tab="patient">${icon('patient')} Ask the patient</button><button id="lab-tab" class="tab" role="tab" aria-controls="question-panel" aria-selected="${tab==='lab'}" data-tab="lab">${icon('lab')} Request tests</button></div><form id="question-form" class="compose-body" role="tabpanel" aria-labelledby="${tab}-tab"><div id="question-panel">${tab==='patient'?`<label for="patient-question" class="field-label">What would you like to ask?</label><textarea id="patient-question" class="input" maxlength="2000" required placeholder="Ask about symptoms, medical history or the examination…">${escapeHTML(draft.question)}</textarea>`:`<label class="field-label">Select the findings you would like to request</label><div class="test-list">${caseData.available_tests.length?caseData.available_tests.map((test,i)=>`<label class="test-option"><input type="checkbox" name="test" id="test-${i}" value="${escapeHTML(test)}" ${draft.tests.includes(test)?'checked':''}>${escapeHTML(test)}</label>`).join(''):'<p class="muted">No tests are available for this case. You can question the patient instead.</p>'}</div>`}</div><div class="compose-foot"><small>One submission uses one round.<br>Patient and lab share 3 rounds.</small><button class="btn" type="submit" ${busy || (tab==='lab'&&!draft.tests.length)?'disabled':''}>${tab==='patient'?'Send question':'Request findings'} ${arrow}</button></div></form></div>`;
}
function diagnosisPanel() {
  const finished = caseData.rounds_used>=3 && !caseData.pending;
  return `<aside class="card diagnosis-panel"><div class="diagnosis-mark">${icon('check')}</div><h2>${finished ? 'Your final diagnosis' : 'Ready to decide?'}</h2><p>${finished?'You have completed all three rounds. Make your diagnosis using the information you have gathered.':'You don’t need to use every round. Submit as soon as you have enough information.'}</p><form id="diagnosis-form"><label for="diagnosis">Most likely diagnosis</label><textarea id="diagnosis" class="input" required maxlength="2000" placeholder="Enter a specific diagnosis…">${escapeHTML(draft.diagnosis)}</textarea><div class="confidence-head"><label for="confidence">Your confidence</label><output id="confidence-value" for="confidence">${draft.confidence}%</output></div><input id="confidence" class="confidence-range" type="range" min="0" max="100" value="${draft.confidence}"><div class="scale-labels"><span>0% · Not confident</span><span>100% · Certain</span></div><button class="btn block" type="submit" ${busy||caseData.pending?'disabled':''}>Submit diagnosis ${arrow}</button></form><p class="footnote">${caseData.pending?'Available once the current response arrives.':'You’ll review your answer before submitting.'}</p></aside>`;
}
function clinicalCase() {
  if (!caseData) return '<div class="loading"><p>Loading your case…</p></div>';
  return `<div class="workspace">${sidebar()}<section><div class="case-heading"><div><span class="eyebrow">Clinical assessment <span aria-hidden="true">/</span> Case review</span><h1>Case ${String(session.completed_cases+1).padStart(2,'0')} <span class="muted">of ${String(session.total_cases).padStart(2,'0')}</span></h1></div>${session.is_demo?'<span class="badge">Synthetic demo case</span>':''}</div><div class="case-grid"><div><article class="card case-card"><div class="card-label">${icon('file')} Initial presentation</div><h2>${escapeHTML(caseData.title)}</h2><p class="vignette">${escapeHTML(caseData.opening)}</p><div class="vignette-foot">${icon('lock')} Additional information is revealed through your questions.</div></article><section class="investigate" aria-labelledby="investigate-heading"><div class="investigate-heading"><h2 id="investigate-heading">Investigate the case</h2><div class="round-count" aria-label="${caseData.rounds_used} of 3 rounds used">${[1,2,3].map(n=>`<span class="${n<=caseData.rounds_used?'used':''}">${n<=caseData.rounds_used?'✓':n}</span>`).join('')}</div></div><p>Choose what you need to know before making your diagnosis.</p><div id="transcript">${turns()}</div>${questionComposer()}</section></div>${diagnosisPanel()}</div><p class="case-bottom">${icon('lock')} Your submitted questions, responses and diagnoses are saved. Case answers are not shown during the study.</p></section></div>`;
}
function receiptPage() {
  return `<section class="center-page"><div class="card"><div class="completion-icon">${icon('check')}</div><span class="eyebrow">Case ${String(receipt.number).padStart(2,'0')} complete</span><h1>Your diagnosis is saved.</h1><p class="intro-text">Take a moment before continuing. You won’t receive feedback on the correct diagnosis during this study.</p><div class="receipt"><span class="eyebrow">Your submitted diagnosis</span><p>${escapeHTML(receipt.diagnosis)}</p><small>${receipt.confidence}% confidence · ${receipt.rounds} of 3 rounds used</small></div><button class="btn block" data-action="next-case">${session.step?.kind==='final_check'?'Continue to final check':'Continue to next case'} ${arrow}</button></div></section>`;
}
function finalCheck() {
  return `<section class="center-page"><div class="card"><span class="eyebrow">All ${session.total_cases} cases completed</span><h1>One final check.</h1><p class="intro-text">Thank you for sharing your clinical reasoning. Would you like your responses to be included in the research analysis?</p><form id="final-form"><label class="choice"><input type="radio" name="inclusion" value="yes" ${inclusion===true?'checked':''} required><span>Yes, include my responses.<small>I am comfortable with my responses being used in the study.</small></span></label><label class="choice"><input type="radio" name="inclusion" value="no" ${inclusion===false?'checked':''} required><span>No, exclude my responses.<small>This choice does not change the completion route or payment eligibility.</small></span></label><div class="form-actions"><small>${session.is_demo?'This is a development preview; there is no Prolific payment or submission.':'Your selection is saved separately from study completion.'}</small><button class="btn" type="submit" ${busy?'disabled':''}>Finish study ${arrow}</button></div></form></div></section>`;
}
function completed() {
  return `<section class="center-page"><div class="card"><div class="completion-icon">${icon('check')}</div><span class="eyebrow">Session complete</span><h1>Thank you for your time.</h1><p class="intro-text">All ${session.total_cases} diagnoses have been saved. ${session.include_in_analysis?'Your responses are marked for inclusion in the analysis.':'Your responses are marked for exclusion from the analysis.'}</p>${session.completion_url ? `<a class="btn block" href="${escapeHTML(session.completion_url)}">Return to Prolific ${arrow}</a>` : session.is_demo ? `<button class="btn block" data-action="new-demo">Start a new demo ${arrow}</button><p class="demo-note">Preview complete. No submission was sent to Prolific. The 150 selected MedQA, NEJM and MediQ cases will replace the synthetic cases once uploaded.</p>` : '<p class="demo-note">Your completion is recorded. Please return to your Prolific study page or contact the study team if you need help completing your submission.</p>'}</div></section>`;
}
function render() {
  const focusId = document.activeElement?.id;
  const selection = document.activeElement?.selectionStart;
  const content = !session ? welcome() : receipt ? receiptPage() : session.status==='completed' ? completed() : session.step.kind==='diagnosis' ? clinicalCase() : session.step.kind==='final_check' ? finalCheck() : background();
  $('#app').innerHTML = shell(content);
  if (focusId) {
    const focused = document.getElementById(focusId);
    focused?.focus({preventScroll:true});
    if (selection != null && focused?.setSelectionRange) { try { focused.setSelectionRange(selection,selection); } catch {} }
  }
}
function topFocus() { window.scrollTo({top:0,behavior:'instant'}); const h = $('#main h1'); if (h) { h.tabIndex=-1; h.focus({preventScroll:true}); } }
function showHelp() {
  $('#dialog').innerHTML = `<h2 id="dialog-title">Your study guide</h2><ol><li>Review the initial presentation for each assigned case.</li><li>Use up to <strong>three rounds in total</strong> to ask the patient questions or request tests. Several selected tests in one submission count as one round.</li><li>Submit the most likely diagnosis and your confidence. You may submit before using any rounds.</li></ol><p>A failed response does not use a round. Your submitted work is stored on the server; keep this tab open to preserve your access. Unsubmitted drafts stay in this tab.</p><p>The patient and lab are AI agents. The study uses one assigned model throughout your session. No diagnostic suggestions or correctness feedback are shown.</p><div class="dialog-actions"><button class="btn" data-action="close-dialog">Got it</button></div>`;
  $('#dialog').showModal();
}
function confirmDiagnosis() {
  $('#dialog').innerHTML = `<h2 id="dialog-title">Submit this diagnosis?</h2><p>Your answer for this case will be final. You won’t be able to ask further questions or edit it.</p><div class="receipt"><span class="eyebrow">Your diagnosis</span><p>${escapeHTML(draft.diagnosis.trim())}</p><small>${draft.confidence}% confidence · ${caseData.rounds_used} of 3 rounds used</small></div><div class="dialog-actions"><button class="btn secondary" data-action="close-dialog">Keep editing</button><button class="btn" data-action="confirm-diagnosis">Confirm diagnosis ${arrow}</button></div>`;
  $('#dialog').showModal();
}
document.addEventListener('input', event => {
  const el = event.target;
  if (el.id === 'consent') { consent = el.checked; $('[data-action="start"]').disabled = !consent || busy; }
  if (el.id === 'patient-question') draft.question = el.value;
  if (el.name === 'test') {
    draft.tests = [...document.querySelectorAll('input[name="test"]:checked')].map(t=>t.value);
    $('#question-form button[type="submit"]').disabled = !draft.tests.length || busy;
  }
  if (el.id === 'diagnosis') draft.diagnosis = el.value;
  if (el.id === 'confidence') { draft.confidence = Number(el.value); $('#confidence-value').textContent = `${el.value}%`; }
  if (el.closest('#background-form')) formDraft[el.name] = el.type==='checkbox' ? el.checked : el.value;
  if (el.name==='inclusion') inclusion = el.value==='yes';
  saveDraft();
});
document.addEventListener('click', event => {
  const el = event.target.closest('button[data-action],button[data-tab]');
  if (!el) return;
  if (el.dataset.tab) { tab = el.dataset.tab; render(); document.getElementById(`${tab}-tab`)?.focus(); return; }
  const action = el.dataset.action;
  if (action==='help') return showHelp();
  if (action==='close-dialog') return $('#dialog').close();
  if (action==='dismiss-error') { error=''; render(); return; }
  if (action==='reload') return location.reload();
  if (action==='new-demo') { sessionStorage.removeItem(storeKey); location.reload(); return; }
  if (action==='next-case') { act(async()=>{ await loadCase(); receipt=null; render(); topFocus(); }); return; }
  if (action==='start') act(async()=>{
    if (!consent) return;
    if (config.workflow !== 'clinician') throw new Error('This participant interface requires a clinician study configuration.');
    let body = {consent:true};
    let path = '/v1/preview/sessions';
    if (!config.is_demo) {
      path = `/v1/studies/${encodeURIComponent(studyId)}/sessions`;
      for (const name of ['PROLIFIC_PID','STUDY_ID','SESSION_ID']) {
        if (!/^[a-zA-Z0-9]{24}$/.test(params.get(name)||'')) throw new Error('Please enter through your Prolific study link. The participant details in this URL are incomplete.');
        body[name] = params.get(name);
      }
      body.consent_version=config.consent_version;
    }
    session = await api(path,body); token=session.session_token; persist(); await loadCase(); render(); topFocus();
  });
  if (action==='confirm-diagnosis') {
    $('#dialog').close();
    act(async()=>{
      const submitted = {number:session.completed_cases+1,diagnosis:draft.diagnosis.trim(),confidence:Number(draft.confidence),rounds:caseData.rounds_used};
      const body = idempotent('diagnosis',{revision:session.revision,diagnosis:submitted.diagnosis,confidence:submitted.confidence});
      session = await api(`/v1/sessions/${session.id}/cases/${session.step.id}/diagnosis`,body);
      pendingRequest=null; sessionStorage.removeItem(draftKey); persist(); receipt=submitted; caseData=null; render(); topFocus();
    });
  }
});
document.addEventListener('keydown', event => {
  if (event.target.matches('[role="tab"]') && ['ArrowLeft','ArrowRight','Home','End'].includes(event.key)) {
    event.preventDefault(); tab = event.key==='Home'?'patient':event.key==='End'?'lab':tab==='patient'?'lab':'patient'; render(); document.getElementById(`${tab}-tab`).focus();
  }
});
document.addEventListener('submit', event => {
  event.preventDefault();
  if (event.target.id==='diagnosis-form') { if (draft.diagnosis.trim()) confirmDiagnosis(); else $('#diagnosis').focus(); return; }
  if (event.target.id==='question-form') act(async()=>{
    const body = idempotent('question',{revision:session.revision,target:tab,question:tab==='patient'?draft.question.trim():'',tests:tab==='lab'?draft.tests:[]});
    const data = await api(`/v1/sessions/${session.id}/cases/${session.step.id}/questions`,body);
    session=data.session; caseData=data.case; draft.question=''; draft.tests=[]; saveDraft(); persist(); pendingRequest=null; schedulePoll();
    $('#announcer').textContent='Request saved. Waiting for the agent response.';
  });
  if (event.target.id==='background-form' || event.target.id==='final-form') act(async()=>{
    const answers = {};
    for (const q of session.step.questions) { const value=formDraft[q.id]; answers[q.id]=q.kind==='number' && value!=='' && value!=null?Number(value):value ?? null; }
    const body = idempotent('step',{revision:session.revision,answers,include_in_analysis:session.step.kind==='final_check'?inclusion:null});
    session=await api(`/v1/sessions/${session.id}/steps/${session.step.id}`,body);
    formDraft={}; pendingRequest=null; persist(); await loadCase(); render(); topFocus();
  });
});
async function init() {
  try {
    try { const saved = JSON.parse(sessionStorage.getItem(storeKey)); if (saved) { token=saved.token; session={id:saved.id}; await refresh(); } }
    catch (e) { session=null; error=e.message; }
    if (!session) config=await api(studyId?`/v1/studies/${encodeURIComponent(studyId)}`:'/v1/preview');
  } catch (e) { error = e.message; }
  render();
}
init();
