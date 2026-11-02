/* Accessible questions over one canonical catalog. No image or project policy. */
(function (root) {
  'use strict';
  function mount(container, options) {
    const api=root.TboxGuidedCatalog;
    let model=options.model, state=api.initialState(model), step=0, conflict=null, suspended=false, busy=false;
    let choosing = !options.simpleStart;
    const acknowledgements=new Map();
    const el=(tag,text,className)=>{const node=document.createElement(tag);if(text!==undefined)node.textContent=text;if(className)node.className=className;return node;};
    const button=(text,action,className='secondary')=>{const node=el('button',text,className);node.type='button';node.addEventListener('click',action);return node;};
    const label=(facet,value)=>model.facetPresentation[facet]?.values.find(v=>v.id===value)?.label||value;
    const currentPath=()=>model.paths.find(p=>p.id===state.pathId);
    function questions() {
      const all=api.candidates(model,state);
      return currentPath().facets.filter(facet=>{
        const choices=api.facetOptions(model,state,facet).filter(v=>!v.disabled);
        if(state.filters[facet])return true;
        if(choices.length<=1)return false;
        // A question that cannot narrow the image identity is a resolved fact.
        const sets=choices.map(v=>api.candidates(model,{...state.filters,[facet]:v.id}).map(l=>l.id).sort().join('\n'));
        return sets.some(value=>value!==sets[0]) || !all.length;
      });
    }
    function selection() { const leaf=api.resolveSelection(model,state);return leaf && leaf.notices.filter(n=>n.requiresAcknowledgement).every(n=>acknowledgements.get(leaf.evidenceKey)?.has(n.code))?leaf:null; }
    function publish() { options.onSelection?.(suspended?null:selection(),state); }
    function transition(result, focusId) {
      if(busy)return;
      if(!result.ok){conflict=result.conflict?{...result.conflict,reason:result.reason}:null;render(focusId,result.reason);return;}
      state=result.state;conflict=null;suspended=false;publish();render(focusId);
    }
    function summary(parent) {
      const chips=el('div',undefined,'guided-chips');
      for(const [facet,value]of Object.entries(state.filters))chips.append(button(`${model.facetPresentation[facet].label}: ${label(facet,value)} ×`,()=>{step=0;transition(api.clearFacet(model,state,facet),'guided-question');},'guided-chip'));
      if(chips.children.length)parent.append(chips);
      const candidates=api.candidates(model,state);
      const status=el('p',`${candidates.length} ${candidates.length===1?'image matches':'images match'} your choices.`,'helper');status.id='guided-status';status.setAttribute('role','status');status.setAttribute('aria-live','polite');parent.append(status);
      const facts=el('ul',undefined,'guided-resolved');
      for(const facet of currentPath().facets){if(state.filters[facet])continue;const values=[...new Set(candidates.flatMap(l=>l.facets[facet]||[]))];if(values.length===1 && candidates.every(leaf=>leaf.facets[facet]?.length===1 && leaf.facets[facet][0]===values[0]))facts.append(el('li',`${model.facetPresentation[facet].label}: ${label(facet,values[0])}`));}
      if(facts.children.length)parent.append(facts);
    }
    function leafCard(leaf) {
      const card=el('article',undefined,'guided-leaf');card.dataset.leafId=leaf.id;
      const names=['family','base','desktop','edition','hardware','platform'].flatMap(f=>leaf.facets[f]?.map(v=>label(f,v))||[]);
      card.append(el('h3',names.join(' · ')));
      const qualification=leaf.source.kind==='preview'?{text:'Preview only — no inspection or ISO creation.'}:options.qualification?.(leaf.entry)||{text:'Browser build not yet verified.'};
      card.append(el('p',qualification.text,'helper'));
      const required=leaf.notices.filter(n=>n.requiresAcknowledgement);
      const accepted=()=>required.every(n=>acknowledgements.get(leaf.evidenceKey)?.has(n.code));
      for(const notice of leaf.notices){const p=el('p',notice.text,'note');if(notice.sourceUrl){p.append(' ',Object.assign(el('a','Details'),{href:notice.sourceUrl,target:'_blank',rel:'noopener'}));}card.append(p);}
      const details=el('details');details.append(el('summary','Image details'));details.append(el('code',leaf.entry?.publication?.ref||leaf.source.ref));card.append(details);
      const use=button(state.selectedLeafId===leaf.id?'Selected image':'Use this image',()=>transition(api.selectLeaf(model,state,leaf.id),'guided-selection-summary'),'guided-use');use.disabled=!leaf.selectable||!accepted();use.setAttribute('aria-pressed',String(state.selectedLeafId===leaf.id));card.append(use);
      for(const notice of required){const row=el('label',undefined,'guided-ack');const check=el('input');check.type='checkbox';check.id='guided-ack-'+leaf.id.replace(/[^a-z0-9-]/g,'-')+'-'+notice.code;check.checked=acknowledgements.get(leaf.evidenceKey)?.has(notice.code)||false;check.addEventListener('change',()=>{const set=acknowledgements.get(leaf.evidenceKey)||new Set();check.checked?set.add(notice.code):set.delete(notice.code);acknowledgements.set(leaf.evidenceKey,set);use.disabled=!leaf.selectable||!accepted();publish();render(check.id);});row.append(check,document.createTextNode('I understand: '+notice.text));card.insertBefore(row,use);}
      if(!leaf.selectable)card.append(el('p',leaf.unavailableReason,'note'));
      return card;
    }
    function render(focusId,message) {
      container.replaceChildren();
      if (!choosing && model.recommendations.length) {
        const heading=el('h3','A starting point for your installation');
        heading.id='guided-start'; heading.tabIndex=-1; container.append(heading);
        for (const rec of model.recommendations.slice(0,1)) {
          const leaf=model.leaves.find(item=>item.id===rec.leaf_id);
          container.append(el('p',rec.reason,'helper'));
          if (leaf) container.append(leafCard(leaf));
          else container.append(el('p','The maintained starting point is unavailable. No substitute has been selected.','note'));
        }
        container.append(el('p','Choose for the computer you will install on. It may be different from the computer running this browser. A starting point is not an installation or compatibility guarantee.','helper'));
        container.append(button('Help me choose / browse all setups',()=>{choosing=true;render('guided-question');}));
        if(busy) for(const control of container.querySelectorAll('button,input')) control.disabled=true;
        if(focusId)(container.querySelector(`#${focusId}`)||heading).focus();
        return;
      }
      const paths=el('div',undefined,'guided-paths');paths.setAttribute('role','group');paths.setAttribute('aria-label','How would you like to choose?');
      for(const path of model.paths){const choose=button(path.label,()=>{step=0;transition(api.changePath(model,state,path.id),'guided-question');});choose.setAttribute('aria-pressed',String(path.id===state.pathId));paths.append(choose);}if(model.paths.length>1)container.append(paths);
      if(state.unavailable){const warning=el('p',`${state.origin==='default'?'The recommended image is unavailable. ':''}${state.unavailable.reason} Choose another image below.`,'note');warning.id='guided-unavailable';warning.setAttribute('role','status');container.append(warning);}
      if(suspended)container.append(el('p','Advanced image mode is active. Choose a catalog image to return to guided selection.','note'));
      const selected=selection();
      if(selected&&!suspended){const chosen=el('p',`Selected: ${['family','base','desktop','platform'].flatMap(f=>selected.facets[f]?.map(v=>label(f,v))||[]).join(' · ')}`,'guided-selected');chosen.id='guided-selection-summary';chosen.tabIndex=-1;container.append(chosen);}
      for(const rec of model.recommendations){const leaf=api.candidates(model,state).find(l=>l.id===rec.leaf_id);if(!leaf)continue;const box=el('aside',undefined,'guided-recommendation');box.append(el('strong',rec.label),el('p',rec.reason,'helper'),button(leaf.notices.some(n=>n.requiresAcknowledgement)?'Review this starting point':'Use this starting point',()=>{if(leaf.notices.some(n=>n.requiresAcknowledgement)){step=questions().length;render('guided-review');}else transition(api.selectLeaf(model,state,leaf.id),'guided-selection-summary');}));container.append(box);}
      summary(container);
      const list=questions();step=Math.min(step,list.length);
      const crumbs=el('nav',undefined,'guided-breadcrumbs');crumbs.setAttribute('aria-label','Image questions');
      list.slice(0,step).forEach((facet,index)=>{crumbs.append(button(model.facetPresentation[facet].label,()=>{step=index;render('guided-question');}));});
      if(crumbs.childElementCount)container.append(crumbs);
      if(message){const note=el('p',message,'note');note.setAttribute('role','alert');container.append(note);}
      if(conflict){const box=el('div',undefined,'guided-conflict');box.setAttribute('role','alert');box.append(el('p',`This change will clear: ${conflict.affected.map(c=>`${model.facetPresentation[c.facetId].label}: ${label(c.facetId,c.value)}`).join(', ')}.`));box.append(button('Clear those choices and continue',()=>{state=conflict.proposedState;conflict=null;suspended=false;publish();render('guided-question');}),button('Keep my choices',()=>{conflict=null;render('guided-question');}));container.append(box);}
      if(step<list.length){
        const facet=list[step], presentation=model.facetPresentation[facet];
        const field=el('fieldset',undefined,'guided-question');field.id='guided-question';field.tabIndex=-1;field.append(el('legend',presentation.label));if(presentation.description)field.append(el('p',presentation.description,'helper'));
        const grid=el('div',undefined,'guided-choice-grid');
        api.facetOptions(model,state,facet).forEach((choice,index)=>{
          const row=el('div',undefined,'guided-choice-wrap');const card=el('label',undefined,`guided-choice${choice.card?' guided-art-card':''}`);card.classList.toggle('is-selected',choice.selected);card.classList.toggle('is-disabled',choice.disabled);
          const input=el('input');input.type='radio';input.name=`guided-${facet}`;input.value=choice.id;input.checked=choice.selected;input.disabled=choice.disabled;input.id=`guided-choice-${step}-${index}`;
          input.addEventListener('change',()=>transition(api.chooseFacet(model,state,facet,choice.id),input.id));card.append(input);
          if(choice.card){const img=el('img');img.src=choice.card.image_url;img.alt=choice.card.image_alt;img.loading='lazy';card.append(img);if(choice.card.badge)card.append(el('span',choice.card.badge,'guided-card-badge'));}
          const copy=el('span',undefined,'guided-choice-copy');copy.append(el('strong',choice.label));if(choice.description)copy.append(el('span',choice.description));copy.append(el('small',choice.disabled?choice.reason:`${choice.count} matching ${choice.count===1?'image':'images'}`));card.append(copy);row.append(card);
          if(choice.disabled){const result=api.chooseFacet(model,state,facet,choice.id);if(result.conflict)row.append(button('Change related choices…',()=>transition(result,'guided-question')));}
          grid.append(row);
        });field.append(grid);container.append(field);
        const controls=el('div',undefined,'guided-controls');if(step>0)controls.append(button('Back',()=>{step--;render('guided-question');}));const next=button(step+1<list.length?`Next: ${model.facetPresentation[list[step+1]].label}`:'Review images',()=>{step++;render(step<list.length?'guided-question':'guided-review');},'guided-next');next.disabled=!state.filters[facet];controls.append(next);container.append(controls);
      }else{
        const review=el('div',undefined,'guided-review');review.id='guided-review';review.tabIndex=-1;review.append(el('h3','Review your image'));
        const candidates=api.candidates(model,state);
        if(!candidates.length)review.append(el('p','No available image matches these choices. Remove a choice above to see alternatives.','note'));
        if(candidates.length>24)review.append(el('p','Narrow your choices further before selecting an image.','note'));
        else for(const leaf of candidates)review.append(leafCard(leaf));
        if(list.length)review.append(button('Back',()=>{step=list.length-1;render('guided-question');}));container.append(review);
      }
      if(busy) for(const control of container.querySelectorAll("button,input")) control.disabled=true;
      if(focusId)container.querySelector(`#${focusId}`)?.focus();
    }
    render();publish();
    return Object.freeze({
      getState:()=>state,
      getSelection:()=>suspended?null:selection(),
      refresh(nextModel){model=nextModel;state=api.refreshState(model,state);publish();render();},
      select(id){choosing=true;transition(api.selectLeaf(model,state,id),'guided-selection-summary');},
      suspend(){suspended=true;render();},
      setBusy(value){busy=Boolean(value);render();},
    });
  }
  root.TboxGuidedPicker={mount};
})(globalThis);
