import { deflateSync } from 'node:zlib';

function crc32(bytes: Buffer) {
  let crc=0xffffffff;
  for(const byte of bytes){crc^=byte;for(let bit=0;bit<8;bit++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);}
  return(crc^0xffffffff)>>>0;
}
function chunk(type: string, data: Buffer) {
  const name=Buffer.from(type),length=Buffer.alloc(4),checksum=Buffer.alloc(4);
  length.writeUInt32BE(data.length);checksum.writeUInt32BE(crc32(Buffer.concat([name,data])));
  return Buffer.concat([length,name,data,checksum]);
}

/** Generated empty field. One image pixel equals 0.1 pitch metres; there are deliberately no people. */
export function emptyPitchPng() {
  const width=1050,height=680,stride=width*3+1,pixels=Buffer.alloc(stride*height);
  const paint=(x:number,y:number)=>{
    const boundary=x<3||x>=width-3||y<3||y>=height-3;
    const halfway=Math.abs(x-525)<2;
    const penalty=(Math.abs(y-138.4)<2||Math.abs(y-541.6)<2)&&x<=165||Math.abs(x-165)<2&&y>=138.4&&y<=541.6;
    return boundary||halfway||penalty;
  };
  for(let y=0;y<height;y++)for(let x=0;x<width;x++){
    const index=y*stride+1+x*3,white=paint(x,y);
    pixels[index]=white?236:48;pixels[index+1]=white?243:111;pixels[index+2]=white?230:57;
  }
  const header=Buffer.alloc(13);header.writeUInt32BE(width,0);header.writeUInt32BE(height,4);header[8]=8;header[9]=2;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',deflateSync(pixels)),chunk('IEND',Buffer.alloc(0))]);
}
