/* Messenger-style output shared by preview and both PNG exporters. */
(() => {
  'use strict';
  const box=(c,x,y,w,h,r,color)=>{c.beginPath();c.roundRect(x,y,w,h,r);c.fillStyle=color;c.fill();};
  function heart(c,x,y,size,rotation,color){
    c.save();c.translate(x,y);c.rotate(rotation);c.scale(size,size);c.beginPath();
    c.moveTo(0,.32);c.bezierCurveTo(-.85,-.16,-.65,-.72,0,-.38);c.bezierCurveTo(.65,-.72,.85,-.16,0,.32);c.fillStyle=color;c.fill();c.restore();
  }
  function background(c,w,h){
    c.fillStyle='#351b3c';c.fillRect(0,0,w,h);
    // Fixed coordinates keep the wallpaper consistent between preview and export.
    heart(c,300,310,510,-.23,'#701638');heart(c,410,280,450,.16,'#9a0759');
    heart(c,780,940,390,-.25,'#790785');heart(c,805,950,330,.12,'#a0048c');
    heart(c,280,1450,440,.3,'#701638');heart(c,335,1430,350,-.14,'#a71a53');
    c.fillStyle='#351b3c30';c.fillRect(0,0,w,h);
  }
  function lines(c,text,max){
    const out=[];
    for(const p of text.split('\n')){let line='';for(const word of p.split(' ')){
      const next=line?line+' '+word:word;
      if(c.measureText(next).width<=max){line=next;continue;}
      if(line)out.push(line);line='';
      for(const ch of word){if(line&&c.measureText(line+ch).width>max){out.push(line);line='';}line+=ch;}
    }out.push(line);}return out;
  }
  function photo(c,im,x,y,w,h,fit='cover'){
    if(fit==='contain'){const k=Math.min(w/im.width,h/im.height);c.drawImage(im,x+(w-im.width*k)/2,y+(h-im.height*k)/2,im.width*k,im.height*k);return;}
    const k=Math.max(w/im.width,h/im.height),sw=w/k,sh=h/k;c.drawImage(im,(im.width-sw)/2,(im.height-sh)/2,sw,sh,x,y,w,h);
  }
  function caption(c,text,w,h,position){
    if(!text)return false;
    const font=46;c.font=`bold ${font}px Arial`;const ls=lines(c,text,w-130),height=ls.length*font*1.3;
    const top=position==='top'?h*.15:position==='bottom'?h-height-100:(h-height)/2;
    c.save();c.textAlign='center';c.lineJoin='round';c.lineWidth=9;c.strokeStyle='#080808';c.fillStyle='#fff';
    ls.forEach((l,i)=>{const y=top+font+i*font*1.3;c.strokeText(l,w/2,y);c.fillText(l,w/2,y);});c.restore();
    return top<20||top+height>h-20;
  }
  function render(canvas,state,slide,images,avatar){
    const w=1080,h={portrait:1920,feed:1350,square:1080}[state.ratio];
    canvas.width=w;canvas.height=h;const c=canvas.getContext('2d');background(c,w,h);
    const ms=slide.messages,font=Number(state.font),lineH=font*1.28;
    let y=50;const boxes=[];let focusBox=null;
    const focus=slide.focus?ms.findLastIndex(m=>m.kind==='text'&&m.side==='out'):-1;
    if(focus>=0)y=300;
    for(let i=0;i<ms.length;i++){
      const m=ms[i],incoming=m.side==='in',ims=images[i]||[];
      if(m.kind==='cover'){
        c.fillStyle='#211326';c.fillRect(0,0,w,h);
        if(ims[0])photo(c,ims[0],0,0,w,h,slide.imageFit||'contain');
        else{c.fillStyle='#d4b4da';c.font='36px Arial';c.fillText('Thêm ảnh của bạn',90,h/2);}
        y=h-30;continue;
      }
      if(m.divider){
        c.font='30px Arial';c.textAlign='center';c.fillStyle='#b7a4bf';c.fillText('Tin nhắn mới',w/2,y+32);c.textAlign='left';
        c.strokeStyle='#b7a4bf';c.lineWidth=2;c.beginPath();c.moveTo(24,y+22);c.lineTo(360,y+22);c.moveTo(720,y+22);c.lineTo(w-24,y+22);c.stroke();y+=74;
      }
      let bw,bh,ls=[];
      c.font=`${font}px Arial`;
      if(m.kind==='text'){ls=lines(c,m.text,800);bw=Math.min(880,Math.max(100,...ls.map(l=>c.measureText(l).width+64)));bh=ls.length*lineH+44;}
      else if(ims.length===1){bw=530;bh=Math.min(790,bw*ims[0].height/ims[0].width);bw=bh*ims[0].width/ims[0].height;if(bw>800){bw=800;bh=bw*ims[0].height/ims[0].width;}}
      else{bw=620;bh=ims.length>2?620:310;}
      const x=incoming?(state.showAvatar?94:24):w-bw-24;
      const prev=ms[i-1],next=ms[i+1],joinedPrev=prev?.side===m.side&&prev.kind==='text'&&m.kind==='text'&&!m.divider&&!state.showTime;
      const joinedNext=next?.side===m.side&&next.kind==='text'&&m.kind==='text'&&!next.divider&&!state.showTime;
      if(incoming&&state.showAvatar&&!joinedNext){c.save();c.beginPath();c.arc(48,y+bh-28,28,0,Math.PI*2);c.clip();if(avatar)photo(c,avatar,20,y+bh-56,56,56);else{c.fillStyle='#745382';c.fillRect(20,y+bh-56,56,56);c.fillStyle='#fff';c.font='26px Arial';c.fillText((state.name.trim()[0]||'E').toUpperCase(),37,y+bh-18);}c.restore();}
      if(m.kind==='text'){
        const r=[joinedPrev&&incoming?12:55,joinedPrev&&!incoming?12:55,joinedNext&&!incoming?12:55,joinedNext&&incoming?12:55];
        box(c,x,y,bw,bh,r,incoming?'#503080':'#e5afe6');c.font=`${font}px Arial`;c.fillStyle=incoming?'#fff':'#110c14';ls.forEach((l,j)=>c.fillText(l,x+32,y+22+font+j*lineH));
      }else{
        c.save();c.beginPath();c.roundRect(x,y,bw,bh,58);c.clip();
        if(!ims.length){c.fillStyle='#503080';c.fillRect(x,y,bw,bh);c.fillStyle='#e9d7ee';c.font='32px Arial';c.fillText('Thêm ảnh vào tin nhắn',x+30,y+bh/2);}
        ims.forEach((im,j)=>{const cols=ims.length===1?1:2,rows=ims.length>2?2:1;photo(c,im,x+(j%cols)*bw/cols,y+Math.floor(j/cols)*bh/rows,bw/cols-4,bh/rows-4);});c.restore();
        if(m.hd){box(c,x+18,y+18,62,39,9,'#0008');c.fillStyle='#fff';c.font='bold 25px Arial';c.fillText('HD',x+28,y+46);}
      }
      boxes.push({index:i,x,y,width:bw,height:bh});if(i===focus)focusBox={x,y,w:bw,h:bh,time:m.time};
      y+=bh;
      if(m.heart){box(c,x+bw-65,y-16,64,48,24,'#23132d');c.font='31px Arial';c.fillText('❤️',x+bw-55,y+19);y+=30;}
      if(state.showTime&&m.time){c.font='23px Arial';c.fillStyle='#bba6c4';c.fillText(m.time,incoming?x:x+bw-64,y+30);y+=40;}
      y+=joinedNext?6:24;
    }
    if(focusBox){
      const f=focusBox,rx=24,ry=Math.max(24,f.y-160);
      box(c,rx,ry,w-48,130,65,'#171a1f');c.font='64px Arial';c.fillStyle='#b5b0be';
      ['❤️','😂','😮','😢','😡','👍','＋'].forEach((e,i)=>c.fillText(e,rx+52+i*137,ry+87));
      const menuY=y+8,mw=520,mh=410;box(c,w-mw-24,menuY,mw,mh,50,'#392e40');
      c.font='26px Arial';c.fillStyle='#b6a8bd';c.fillText(f.time||'22:25',w-mw+10,menuY+55);
      c.fillStyle='#fff';c.font='36px Arial';['↶   Trả lời','✎   Chỉnh sửa','➤   Chuyển tiếp','▱   Xóa ở phía bạn'].forEach((t,i)=>c.fillText(t,w-mw+10,menuY+126+i*81));y=menuY+mh+24;
    }
    const cover=ms.some(m=>m.kind==='cover');
    const outputH=state.trim&&!cover?Math.min(h,Math.ceil(y+26)):h;
    let captionOverflow=false;
    if(focusBox&&slide.overlay){
      c.font='bold 42px Arial';const ls=lines(c,slide.overlay,430),top=focusBox.y+focusBox.h+90;
      c.save();c.lineWidth=8;c.lineJoin='round';c.strokeStyle='#080808';c.fillStyle='#fff';
      ls.forEach((l,i)=>{c.strokeText(l,30,top+i*56);c.fillText(l,30,top+i*56);});c.restore();
      captionOverflow=top+ls.length*56>outputH-20;
    }else captionOverflow=caption(c,slide.overlay||'',w,outputH,slide.overlayPosition||'top');
    return {height:outputH,overflow:y>h-8||captionOverflow,boxes};
  }
  const api={render,background,lines};
  if(typeof module!=='undefined'&&module.exports)module.exports=api;
  if(typeof window!=='undefined')window.MessengerRenderer=api;
})();
