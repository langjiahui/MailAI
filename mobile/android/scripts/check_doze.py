#!/usr/bin/env python3
"""Destructive synthetic-fixture test; use only a dedicated Android emulator with test APKs.

Verifies queue durability with the app process absent, then runs the real constrained
JobScheduler after wake. This accelerates Doze transitions; it is not an overnight soak.
"""
import argparse, subprocess, time, re, json, sqlite3
from pathlib import Path
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--adb', required=True, type=Path)
parser.add_argument('--output', required=True, type=Path)
parser.add_argument('--serial', default='emulator-5554')
args = parser.parse_args()
assert args.serial.startswith('emulator-'), 'Use a dedicated emulator, never a personal phone'
root = args.output.resolve()
root.mkdir(parents=True, exist_ok=True)
adb = str(args.adb.resolve())
serial = args.serial
pkg='com.mailai.mobile.dev'
account='23b057cd-65b1-437f-abf9-5d29fa101a01'
log=[]
def shell(*args):
 r=subprocess.run([adb,'-s',serial,'shell',*args],capture_output=True,text=True,timeout=45)
 return (r.stdout+r.stderr).strip()
def record(key,value):
 log.append({key:value}); print(key, str(value)[:450],flush=True)
 (root/'doze-probe.json').write_text(json.dumps(log,ensure_ascii=False,indent=2))
def queue_count():
 folder=root/'doze-probe-db';folder.mkdir(exist_ok=True)
 name=f'mail-{account}.db'
 for suffix in ('','-wal'):
  out=subprocess.run([adb,'-s',serial,'exec-out','run-as',pkg,'cat',f'databases/{name}{suffix}'],capture_output=True)
  path=folder/(name+suffix)
  if out.returncode==0:path.write_bytes(out.stdout)
  elif path.exists():path.unlink()
 shm=folder/(name+'-shm')
 if shm.exists():shm.unlink()
 with sqlite3.connect(folder/name) as db:return db.execute('select count(*) from arrival_pending').fetchone()[0]
deep=shell('dumpsys','deviceidle','enabled','deep')=='1'
try:
 result=shell('am','instrument','-w','-r','-e','class','com.mailai.mobile.NotificationRecoveryTest#lockedBatterySaverRetainsOrDeliversQueueAndRetriesDoNotDuplicate','-e','mailaiDozeStage','prepare',pkg+'.test/androidx.test.runner.AndroidJUnitRunner')
 assert 'OK (1 test)' in result,result
 work=shell('cat',f'/sdcard/Android/data/{pkg}/files/notification-checks/doze-work-id.txt')
 record('work_id',work)
 shell('input','keyevent','KEYCODE_HOME')
 pid=shell('pidof',pkg)
 if pid:
  assert re.fullmatch(r'\d+',pid),pid
  shell('run-as',pkg,'kill','-9',pid)
 record('fixture_pid_terminated_if_present',pid)
 record('remaining_pid',shell('pidof',pkg))
 shell('dumpsys','deviceidle','enable','deep')
 shell('dumpsys','battery','unplug')
 shell('cmd','power','set-mode','1')
 shell('input','keyevent','KEYCODE_SLEEP')
 record('force_idle',shell('dumpsys','deviceidle','force-idle'))
 time.sleep(16)
 record('idle_state',shell('dumpsys','deviceidle','get','deep'))
 jobs=shell('dumpsys','jobscheduler')
 blocks=re.split(r'\n(?=  JOB )',jobs)
 block=next(b for b in blocks if 'JOB ' in b[:20] and f'Service: {pkg}/' in b)
 (root/'doze-job-idle.txt').write_text(block)
 header=block.splitlines()[0];record('job_header',header)
 jobid=re.search(r'/(\d+):',header)[1]
 namespace='androidx.work.systemjobscheduler' if 'androidx.work.systemjobscheduler' in header else None
 args=['cmd','jobscheduler','run','-s']
 if namespace:args+=['-n',namespace]
 args += [pkg,jobid]
 record('idle_scheduler_attempt',shell(*args))
 record('idle_pending_count',queue_count())
 assert queue_count()==1,'pending lost while process dead in Doze'
 record('idle_pid',shell('pidof',pkg))
 shell('dumpsys','deviceidle','unforce');shell('cmd','power','set-mode','0');shell('dumpsys','battery','reset')
 shell('input','keyevent','KEYCODE_WAKEUP');shell('wm','dismiss-keyguard')
 record('wake_scheduler_attempt',shell(*args))
 deadline=time.monotonic()+35
 while time.monotonic()<deadline:
  if queue_count()==0:break
  time.sleep(1)
 record('after_wake_pending_count',queue_count())
 record('after_wake_pid',shell('pidof',pkg))
 notices=shell('dumpsys','notification')
 (root/'doze-notifications-after.txt').write_text(notices)
 active=[l.strip() for l in notices.splitlines() if 'NotificationRecord(' in l and f'tag=mail.{account}' in l]
 record('after_wake_notifications',active)
 assert queue_count()==0 and len(active)==1,'wake did not deliver exactly one card'
 record('result','PASS: dead-process Doze retained queue; constrained system job delivered after wake')
finally:
 shell('dumpsys','deviceidle','unforce');shell('cmd','power','set-mode','0');shell('dumpsys','battery','reset')
 shell('input','keyevent','KEYCODE_WAKEUP');shell('wm','dismiss-keyguard')
 if not deep:shell('dumpsys','deviceidle','disable','deep')
