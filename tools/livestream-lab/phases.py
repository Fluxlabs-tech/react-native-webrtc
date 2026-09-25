import json, os, re, datetime, sys
S=sys.argv[1]; name=sys.argv[2]; sched=sys.argv[3] if len(sys.argv)>3 else 'fluctuate'
def lab_env(key):
    # The environment, else lab.env's default.
    if key in os.environ: return os.environ[key]
    for line in open(os.path.join(S,'lab.env')):
        m=re.match(r'%s=\$\{%s:-(.*)\}$'%(key,key),line.strip())
        if m: return m.group(1)
A,B=[int(x) for x in [l for l in open(S+'/results/scenarios.txt') if l.startswith(name+' ')][0].split()[1:3]]
for dev,ip in [(lab_env('ANDROID_NAME'),lab_env('ANDROID_IP')),(lab_env('IOS_NAME'),lab_env('IOS_IP'))]:
    steps=[]
    for line in open(S+'/zooplab/logs/zooplab.log'):
        m=re.match(r'(\S+ \S+) \[link\] schedule "%s" on %s: step \d+/\d+ -> (\S+) for'%(sched,re.escape(ip)),line)
        if m:
            t=datetime.datetime.strptime(m.group(1),'%Y/%m/%d %H:%M:%S.%f').timestamp()*1000
            if A-100000<=t<=B: steps.append((t,m.group(2)))
    phase=lambda t: ([n for s,n in steps if s<=t] or ['?'])[-1]
    rows=[json.loads(l)['msg'] for l in open(S+'/zooplab/logs/app-%s.jsonl'%dev)]
    st=[r for r in rows if r.get('type')=='stats' and A<=r['at']<=B]
    agg={}
    for r in st:
        p=phase(r['at']); s=r['stats']; v=s['inbound']['video'] or {}; a=s['inbound']['audio'] or {}
        d=agg.setdefault(p,[0,0,0,0]); d[0]+=1; d[1]+=a.get('concealedPercent',0); d[2]+=v.get('fps',0); d[3]+= 1 if v.get('kbps',0)>500 else 0
    order=['wifi','4g','4g-poor','3g','edge','outage','lossy-10','cap-2000']
    print('%-15s'%dev, ' | '.join(f"{p}: audio concealed {agg[p][1]/agg[p][0]:4.1f}%, video {100*agg[p][3]/agg[p][0]:3.0f}% at {agg[p][2]/max(agg[p][3],1):4.1f} fps" for p in order if p in agg))
