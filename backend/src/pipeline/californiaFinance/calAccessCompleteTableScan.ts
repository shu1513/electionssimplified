import {createHash} from "node:crypto";
import {openCalAccessRawDataTableStream} from "./calAccessRawDataProbe.js";

/** Complete streaming source scan. Filtering happens before allocating historic
 * row objects; every uncompressed byte still contributes to source closure. */
export async function scanCalAccessCompleteTable(input:{zipPath:string;fileName:string;firstColumnValues?:ReadonlySet<string>;
  columnValues?:{column:string;values:ReadonlySet<string>};onRow:(row:Record<string,string>)=>void;maxUncompressedBytes?:number}){
  const {source,stream,entry}=await openCalAccessRawDataTableStream(input.zipPath,input.fileName);
  const max=input.maxUncompressedBytes??6*1024**3;
  if(!Number.isSafeInteger(max)||max<1||entry.uncompressedSize>max){stream.destroy();source.destroy();throw new Error("CAL-ACCESS table byte budget");}
  let pending=Buffer.alloc(0),headers:string[]|null=null,filterColumn=-1,bytes=0,rows=0,selectedRows=0;const sha=createHash("sha256"),decode=new TextDecoder("utf-8",{fatal:true});
  const line=(buffer:Buffer)=>{
    if(buffer.length>1024**2)throw new Error("CAL-ACCESS line budget");
    if(buffer.at(-1)===13)buffer=buffer.subarray(0,-1);if(!buffer.length)return;
    if(!headers){headers=decode.decode(buffer).replace(/^\uFEFF/,"").split("\t");if(headers.length<2||headers.length>200||headers.some(h=>!h)||new Set(headers).size!==headers.length)throw new Error("Invalid CAL-ACCESS table headers");
      if(input.columnValues){filterColumn=headers.indexOf(input.columnValues.column);if(filterColumn<0)throw new Error("Missing CAL-ACCESS filter column");}return;}
    if(++rows>100000000)throw new Error("CAL-ACCESS row budget");
    const firstTab=buffer.indexOf(9);if(firstTab<0)throw new Error("Invalid CAL-ACCESS source row");
    if(input.firstColumnValues&&!input.firstColumnValues.has(buffer.subarray(0,firstTab).toString("utf8")))return;
    if(input.columnValues){let start=0;for(let i=0;i<filterColumn;i++){const end=buffer.indexOf(9,start);if(end<0)throw new Error("Incomplete CAL-ACCESS filter row");start=end+1;}const end=buffer.indexOf(9,start);
      if(!input.columnValues.values.has(decode.decode(buffer.subarray(start,end<0?buffer.length:end))))return;}
    const values=decode.decode(buffer).split("\t");if(values.length!==headers.length)throw new Error("CAL-ACCESS selected row width mismatch");
    input.onRow(Object.fromEntries(headers.map((h,i)=>[h,values[i]!] )));selectedRows++;
  };
  try{for await(const chunk of stream){const b=Buffer.from(chunk);bytes+=b.length;if(bytes>max||bytes>entry.uncompressedSize)throw new Error("CAL-ACCESS table byte overrun");sha.update(b);
    pending=pending.length?Buffer.concat([pending,b]):b;let offset=0,next=0;while((next=pending.indexOf(10,offset))>=0){line(pending.subarray(offset,next));offset=next+1;}pending=pending.subarray(offset);if(pending.length>1024**2)throw new Error("CAL-ACCESS line budget");
  }if(pending.length)line(pending);if(bytes!==entry.uncompressedSize||!headers)throw new Error("Incomplete CAL-ACCESS table");
    return {bytes,rows,selectedRows,sha256:sha.digest("hex"),columns:headers};
  }finally{stream.destroy();source.destroy();}
}
