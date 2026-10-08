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
        for (let yy=0; yy<info.height; yy++) for (let xx=0; xx<info.width; xx++) {
          const src = (yy*info.width+xx)*info.components;
          const dst = ((actual.top-y+yy)*width+actual.left+xx)*components;
          for (let c=0; c<n; c++) data[dst+c] = raw[src+c]/divisor;
          data[dst+n] = info.hasAlpha ? raw[src+n]/divisor : 1;
        }
      } finally { pixels.imageData.dispose(); }
    }
    await api('/images/'+id+'?y='+y+'&rows='+rows, data.buffer);
    report((y+rows)/height);
  }
  return {id, width, height, components, size, profile, colorSpace:n===3?'RGB':'Grayscale', docID:doc.id, layerID:layer.id, name:layer.name};
}

async function uploadPreview(doc, layer, api) {
  const scale=Math.min(1,1600/Math.max(doc.width,doc.height));
  const width=Math.max(1,Math.round(doc.width*scale)),height=Math.max(1,Math.round(doc.height*scale));
  const size=doc.bitsPerChannel===constants.BitsPerChannelType.EIGHT?8:doc.bitsPerChannel===constants.BitsPerChannelType.SIXTEEN?16:32;
  const divisor=size===8?255:size===16?65535:1;
  const n=doc.mode===constants.DocumentMode.RGB?3:1, components=n+1;
  const pixels=await imaging.getPixels({documentID:doc.id,layerID:layer.id,
    sourceBounds:{left:0,top:0,right:doc.width,bottom:doc.height},targetSize:{width,height},componentSize:size,applyAlpha:false});
  let profile;
  const data=new Float32Array(width*height*components);
  try {
    const info=pixels.imageData, raw=await info.getData({chunky:true,fullRange:true});
    profile=info.colorProfile;
    const x0=Math.round(pixels.sourceBounds.left*Math.pow(2,pixels.level)*scale);
    const y0=Math.round(pixels.sourceBounds.top*Math.pow(2,pixels.level)*scale);
    for(let y=0;y<info.height;y++) for(let x=0;x<info.width;x++) {
      const dx=x+x0,dy=y+y0;
      if(dx<0 || dy<0 || dx>=width || dy>=height) continue;
      const src=(y*info.width+x)*info.components,dst=(dy*width+dx)*components;
      for(let c=0;c<n;c++) data[dst+c]=raw[src+c]/divisor;
      data[dst+n]=info.hasAlpha?raw[src+n]/divisor:1;
    }
  } finally { pixels.imageData.dispose(); }
  const {id}=await api('/images',{width,height,components});
  await api('/images/'+id+'?y=0&rows='+height,data.buffer);
  return {id,width,height,components,size:16,profile,colorSpace:n===3?'RGB':'Grayscale',docID:doc.id,layerID:layer.id,name:layer.name};
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
      colorProfile:meta.profile.replace(' (Linear RGB Profile)', ''), fullRange:true});
    try { await imaging.putPixels({documentID:doc.id, layerID:layer.id, imageData, replace:y===0, targetBounds:{left:0,top:y}}); }
    finally { imageData.dispose(); }
    report((y+rows)/meta.height);
  }
  return layer;
}

async function canvasPreview(previewDocID, result, meta, api, report, label='星点重混合') {
  return core.executeAsModal(async context=>{
    let doc=app.documents.find(d=>d.id===previewDocID);
    if(doc && (doc.width!==result.width || doc.height!==result.height)) {
      await doc.closeWithoutSaving(); doc=null;
    }
    if(!doc) doc=await app.createDocument({name:label+'预览（缩略）',width:result.width,height:result.height,
      depth:16,mode:meta.colorSpace==='RGB'?constants.NewDocumentMode.RGB:constants.NewDocumentMode.GRAYSCALE,
      profile:meta.profile.replace(' (Linear RGB Profile)',''),fill:constants.DocumentFill.TRANSPARENT});
    await write(doc,result.id,{...meta,...result,size:16},label+'预览',api,report,context,doc.layers[0]);
    return doc.id;
  },{commandName:'更新重混合预览'});
}

async function transaction(doc, commandName, action) {
  return core.executeAsModal(async context => {
    const history = await context.hostControl.suspendHistory({documentID:doc.id, name:commandName});
    try { const result = await action(context); await context.hostControl.resumeHistory(history); return result; }
    catch(e) { await context.hostControl.resumeHistory(history, false); throw e; }
  }, {commandName});
}

module.exports = {app, core, imaging, constants, layers, documentInfo, upload, uploadPreview, write, canvasPreview, transaction};
