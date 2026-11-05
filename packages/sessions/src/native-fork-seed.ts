/** Retained seed integrity only. Provider formats and paths remain in agent-protocol's codecs. */
import type { NativeFileRef } from "@mend/domain/workbench";

/** Paths and hashes may ride argv; native conversation bytes never do. */
export const nativeSeedProbeArgv = (
  root: string,
  files: ReadonlyArray<Pick<NativeFileRef, "relativePath" | "sha256" | "byteLength">>,
): ReadonlyArray<string> => [
  "node",
  "-e",
  String.raw`
const fs=require("fs"),p=require("path"),c=require("crypto"),k=fs.constants;
const root=process.argv[1],files=JSON.parse(process.argv[2]),missing=[];
try {
  if(!p.isAbsolute(root)||fs.realpathSync(root)!==root)process.exit(3);
  for(const f of files){
    const target=p.join(root,f.relativePath);
    if(!target.startsWith(root+"/"))process.exit(3);
    let current=root,absent=false;
    for(const part of f.relativePath.split("/")){
      current=p.join(current,part);
      let st;
      try{st=fs.lstatSync(current);}catch(e){if(e.code!=="ENOENT")throw e;absent=true;break;}
      if(st.isSymbolicLink()||(current!==target&&!st.isDirectory()))process.exit(3);
    }
    if(absent){missing.push(f.relativePath);continue;}
    if(fs.realpathSync(target)!==target)process.exit(3);
    const fd=fs.openSync(target,k.O_RDONLY|k.O_NOFOLLOW);
    try{
      const st=fs.fstatSync(fd);
      if(!st.isFile()||st.size!==f.byteLength||c.createHash("sha256").update(fs.readFileSync(fd)).digest("hex")!==f.sha256)process.exit(3);
    }finally{fs.closeSync(fd);}
  }
  process.stdout.write(JSON.stringify(missing));
}catch{process.exit(3);}
`,
  root,
  JSON.stringify(files),
];
