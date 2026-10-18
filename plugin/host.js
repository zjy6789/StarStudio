const { app, core, imaging, constants } = require('photoshop');

function layers(doc) {
  const result = [];
  function walk(items, prefix) {
    for (const layer of items) {
      if (layer.layers && layer.layers.length) walk(layer.layers, prefix + layer.name + ' / ');
      else if (layer.kind === constants.LayerKind.NORMAL || layer.kind === constants.LayerKind.SMARTOBJECT) {
        result.push({ id: layer.id, name: prefix + layer.name, layer });
      }
    }
  }
  walk(doc.layers, '');
  return result;
}

function documentInfo(doc=app.activeDocument) {
  if (!app.documents.length) throw new Error('请先打开一张照片。');
  if (doc.mode !== constants.DocumentMode.RGB && doc.mode !== constants.DocumentMode.GRAYSCALE) {
    throw new Error('请使用 RGB 或灰度文档。');
  }
  return doc;
}

async function upload(doc, layer, api, report) {
  const width = doc.width, height = doc.height;
  const size = doc.bitsPerChannel === constants.BitsPerChannelType.EIGHT ? 8 : doc.bitsPerChannel === constants.BitsPerChannelType.SIXTEEN ? 16 : 32;
  const n = doc.mode === constants.DocumentMode.RGB ? 3 : 1;
  const components = n + 1;
  const {id} = await api('/images', {width, height, components});
  const bounds = layer.boundsNoEffects;
  const left = Math.max(0, Math.floor(bounds.left)), right = Math.min(width, Math.ceil(bounds.right));
  const top = Math.max(0, Math.floor(bounds.top)), bottom = Math.min(height, Math.ceil(bounds.bottom));
  if (right <= left || bottom <= top) throw new Error('所选图层在画布内没有像素。');
  let profile = '';
  const rowsPerBlock = Math.min(512, Math.max(1, Math.floor(8*1024*1024/(width*components*4))));
  for (let y=0; y<height; y+=rowsPerBlock) {
    const rows = Math.min(rowsPerBlock, height-y);
    const data = new Float32Array(width*rows*components);
    const t = Math.max(y, top), b = Math.min(y+rows, bottom);
    if (t < b) {
      const pixels = await imaging.getPixels({documentID:doc.id, layerID:layer.id,
        sourceBounds:{left, top:t, right, bottom:b}, componentSize:size, applyAlpha:false});
      try {
        const info = pixels.imageData;
        profile = info.colorProfile;
        const raw = await info.getData({chunky:true, fullRange:true});
        const divisor = size===8 ? 255 : size===16 ? 65535 : 1;
        const actual = pixels.sourceBounds;
        if (actual.left===0 && info.width===width && info.components===(info.hasAlpha?components:n)) {
          const offset=(actual.top-y)*width*components;
          if(info.hasAlpha) {
            if(size===32) data.set(raw,offset);
            else for(let i=0;i<raw.length;i++) data[offset+i]=raw[i]/divisor;
          } else {
            for(let src=0,dst=offset;src<raw.length;src+=n,dst+=components) {
              for(let c=0;c<n;c++) data[dst+c]=raw[src+c]/divisor;
              data[dst+n]=1;
            }
          }
        } else {
        for (let yy=0; yy<info.height; yy++) for (let xx=0; xx<info.width; xx++) {
          const src = (yy*info.width+xx)*info.components;
          const dst = ((actual.top-y+yy)*width+actual.left+xx)*components;
          for (let c=0; c<n; c++) data[dst+c] = raw[src+c]/divisor;
          data[dst+n] = info.hasAlpha ? raw[src+n]/divisor : 1;
        }
        }
      } finally { pixels.imageData.dispose(); }
    }
    await api('/images/'+id+'?y='+y+'&rows='+rows, data.buffer);
    report((y+rows)/height);
  }
  return {id, width, height, components, size, profile, colorSpace:n===3?'RGB':'Grayscale', docID:doc.id, layerID:layer.id, name:layer.name};
}

async function write(doc, key, meta, name, api, report, context, existingLayer) {
  const layer = existingLayer || await doc.createLayer({name});
  const rowsPerBlock = Math.min(512, Math.max(1, Math.floor(8*1024*1024/(meta.width*meta.components*4))));
  for (let y=0; y<meta.height; y+=rowsPerBlock) {
    if (context.isCancelled) throw new Error('用户取消了操作。');
    const rows = Math.min(rowsPerBlock, meta.height-y);
    const response = await api('/images/'+key+'?y='+y+'&rows='+rows, undefined, true);
    const floats = new Float32Array(response);
    let raw = floats;
    if (meta.size===8 || meta.size===16) {
      raw = meta.size===8 ? new Uint8Array(floats.length) : new Uint16Array(floats.length);
      const multiplier = meta.size===8?255:65535;
      for (let i=0; i<raw.length; i++) raw[i] = Math.round(floats[i]*multiplier);
    }
    const imageData = await imaging.createImageDataFromBuffer(raw, {
      width:meta.width, height:rows, components:meta.components, colorSpace:meta.colorSpace,
      // Pixels are already in this document's space. An empty profile inherits
      // its embedded ICC, including profiles unavailable by registered name.
      colorProfile:'', fullRange:true});
    try { await imaging.putPixels({documentID:doc.id, layerID:layer.id, imageData, replace:y===0, targetBounds:{left:0,top:y}}); }
    finally { imageData.dispose(); }
    report((y+rows)/meta.height);
  }
  return layer;
}

function starBlendModes(doc) {
  return doc.bitsPerChannel===constants.BitsPerChannelType.EIGHT || doc.bitsPerChannel===constants.BitsPerChannelType.SIXTEEN
    ? ['normal','lighten','screen','colorDodge','linearDodge','lighterColor','linearLight']
    : ['normal','lighten','linearDodge','lighterColor'];
}

function starEncoding(doc, layer) {
  if(doc.bitsPerChannel===constants.BitsPerChannelType.THIRTYTWO) return 'signed';
  return layer?.blendMode===constants.BlendMode.LINEARLIGHT?'gray':'black';
}

function setStarBlendMode(layer, mode, doc) {
  const names={normal:'NORMAL',lighten:'LIGHTEN',screen:'SCREEN',colorDodge:'COLORDODGE',linearDodge:'LINEARDODGE',lighterColor:'LIGHTERCOLOR',linearLight:'LINEARLIGHT'};
  if(!names[mode]) throw new Error('不支持的星点混合模式。');
  if(doc && !starBlendModes(doc).includes(mode)) throw new Error('Photoshop 的 32 位图层支持正常、变亮、线性减淡（添加）和浅色；请保留 32 位并选择其中一种模式。');
  layer.blendMode=constants.BlendMode[names[mode]];
}

async function canvasStarPreview(state, result, meta, background, blendMode, api, report, isCurrent=()=>true) {
  return core.executeAsModal(async context=>{
    function check() {
      if(!isCurrent()) {const error=new Error('预览设置已更新。');error.stale=true;throw error;}
      if(context.isCancelled) throw new Error('用户取消了操作。');
    }
    check();
    const source=app.documents.find(d=>d.id===meta.docID);
    if(!source) throw new Error('星点来源文档已关闭。');
    if(meta.width!==source.width || meta.height!==source.height ||
      (result && (result.width!==source.width || result.height!==source.height))) {
      throw new Error('星点加工预览必须使用完整分辨率。');
    }
    const previous=app.activeDocument;
    let doc=app.documents.find(d=>d.id===state?.docID);
    if(doc && (state.sourceDocID!==source.id || doc.width!==source.width || doc.height!==source.height || doc.bitsPerChannel!==source.bitsPerChannel)) {
      await doc.closeWithoutSaving();doc=null;state=null;
    }
    const created=!doc;
    if(created) {
      // A duplicate carries the source's embedded ICC and bit depth unchanged.
      // The copied composite is discarded; neither preview source is flattened.
      doc=await source.duplicate('星点加工预览 · '+source.title,true);
      try {
        check();
        const copied=Array.from(doc.layers);
        const stars=await doc.createLayer({name:'星点预览'});
        for(const layer of copied) await layer.delete();
        check();
        state={docID:doc.id,sourceDocID:source.id,starLayerID:stars.id,image:undefined};
      } catch(error) {
        await doc.closeWithoutSaving();
        if(previous && app.documents.some(d=>d.id===previous.id)) app.activeDocument=previous;
        throw error;
      }
    }
    const next={...state};
    const history=await context.hostControl.suspendHistory({documentID:doc.id,name:'更新星点加工预览'});
    try {
      check();
      let stars=doc.layers.find(l=>l.id===next.starLayerID);
      const originalKey=meta.sourceKey || meta.id || source.id+':'+meta.layerID;
      if(!result) {
        if(!stars || next.image!==null || next.originalKey!==originalKey) {
          const original=layers(source).find(l=>l.id===meta.layerID)?.layer;
          if(!original) throw new Error('星点来源图层已删除。');
          const copy=await original.duplicate(doc);check();
          if(copy.allLocked) copy.allLocked=false;
          if(stars) await stars.delete();
          stars=copy;stars.name='星点预览';
          next.starLayerID=stars.id;next.originalKey=originalKey;next.image=null;
        }
      } else if(!stars || next.image!==result.image) {
        if(!stars || next.image===null) {
          const fresh=await doc.createLayer({name:'星点预览'});
          if(stars) await stars.delete();
          stars=fresh;next.starLayerID=stars.id;
        }
        await write(doc,result.image,{...meta,...result},'星点预览',api,report,
          {get isCancelled(){return context.isCancelled || !isCurrent();}},stars);
        check();next.image=result.image;
      }
      let backdrop=doc.layers.find(l=>l.id===next.backgroundLayerID);
      const backgroundKey=background?background.doc.id+':'+background.layer.id+':'+(background.key || ''):null;
      if(backgroundKey!==next.backgroundKey || (background && !backdrop)) {
        if(backdrop) await backdrop.delete();
        backdrop=background?await background.layer.duplicate(doc):null;check();
        if(backdrop) {
          if(backdrop.allLocked) backdrop.allLocked=false;
          backdrop.name='背景预览';backdrop.visible=true;
          backdrop.blendMode=constants.BlendMode.NORMAL;
        }
        next.backgroundLayerID=backdrop?.id;next.backgroundKey=backgroundKey;
      }
      stars.visible=true;setStarBlendMode(stars,blendMode,doc);
      if(backdrop) stars.move(backdrop,constants.ElementPlacement.PLACEBEFORE);
      check();
      await context.hostControl.resumeHistory(history);
      if(!created && previous && app.documents.some(d=>d.id===previous.id)) app.activeDocument=previous;
      return next;
    } catch(error) {
      if(!isCurrent()) error.stale=true;
      await context.hostControl.resumeHistory(history,false);
      if(created && app.documents.some(d=>d.id===doc.id)) await doc.closeWithoutSaving();
      if(previous && app.documents.some(d=>d.id===previous.id)) app.activeDocument=previous;
      throw error;
    }
  },{commandName:'更新星点加工预览'});
}

async function transaction(doc, commandName, action) {
  return core.executeAsModal(async context => {
    const history = await context.hostControl.suspendHistory({documentID:doc.id, name:commandName});
    try { const result = await action(context); await context.hostControl.resumeHistory(history); return result; }
    catch(e) { await context.hostControl.resumeHistory(history, false); throw e; }
  }, {commandName});
}

function findLayer(doc, id) {
  function walk(items) {
    for(const layer of items) {
      if(layer.id===id) return layer;
      if(layer.layers) {const found=walk(layer.layers);if(found) return found;}
    }
  }
  return walk(doc.layers);
}

async function archiveLayer(doc,layer) {
  function visible(items,shown=true) {
    for(const item of items) {
      const active=shown && item.visible && item.opacity!==0;
      if(item.id===layer.id) return active;
      if(item.layers) {const found=visible(item.layers,active);if(found!==undefined) return found;}
    }
  }
  if(!visible(doc.layers)) return;
  // Photoshop may omit visibility toggles from history. A newly created
  // zero-opacity wrapper is structural and restores correctly with one undo.
  const archive=await doc.createLayerGroup({name:layer.name+' · 保留原层（不参与合成）',fromLayers:[layer],
    blendMode:constants.BlendMode.NORMAL});
  archive.opacity=0;
}

async function applyStarResult({doc,source,background,blend,result,meta,previous=[]},api,report) {
  return transaction(doc,'星点加工与合成',async context=>{
    const layer=result?await write(doc,result.image,meta,source.name+'_processed',api,report,context):await source.duplicate(doc);
    if(layer.allLocked) layer.allLocked=false;
    layer.name=source.name+'_processed';layer.visible=true;setStarBlendMode(layer,blend,doc);
    let root=layer;
    if(background) {
      const copy=await background.duplicate(doc);
      if(copy.allLocked) copy.allLocked=false;
      copy.name='背景副本';copy.visible=true;copy.blendMode=constants.BlendMode.NORMAL;
      layer.move(copy,constants.ElementPlacement.PLACEBEFORE);
      root=await doc.createLayerGroup({name:source.name+' · 星点加工合成',fromLayers:[layer,copy],blendMode:constants.BlendMode.NORMAL});
    }
    if(context.isCancelled) throw new Error('用户取消了操作。');
    await archiveLayer(doc,source);
    if(background) await archiveLayer(doc,background);
    for(const id of previous) {const old=findLayer(doc,id);if(old && old.id!==root.id) await archiveLayer(doc,old);}
    const top=doc.layers[0];
    if(root.id!==top.id) root.move(top,constants.ElementPlacement.PLACEBEFORE);
    app.activeDocument=doc;
    return {layer,root};
  });
}

module.exports = {app, core, imaging, constants, layers, findLayer, archiveLayer, documentInfo, upload, write, starBlendModes, starEncoding, setStarBlendMode, canvasStarPreview, transaction, applyStarResult};
