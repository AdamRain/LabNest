import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { mkdirSync, readFileSync, existsSync, lstatSync, unlinkSync, chmodSync, realpathSync, linkSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createLabServer } from '../src/server.mjs';
import { openAccounts } from '../src/accounts.mjs';

export const demoPassword = 'DemoOnly!2026'; // Intentionally public, local demo accounts only.
export const demoVersion = 'fictional-public-demo-v1';
export const releaseRoot = fileURLToPath(new URL('../', import.meta.url));
export const demoCalendarUrl = 'https://calendar.example.test/demo.ics';
const day = 86_400_000;
const date = value => new Date(value + 8 * 3_600_000).toISOString().slice(0, 10);
const iso = value => new Date(value).toISOString();
const sqlTime = value => iso(value).slice(0, 19).replace('T', ' ');
const people = JSON.parse(readFileSync(new URL('../fixtures/demo-people.json', import.meta.url), 'utf8'));

export function demoDates(now = Date.now()) {
  const local = new Date(now + 8 * 3_600_000);
  const week = date(now - ((local.getUTCDay() + 6) % 7) * day);
  const start = Date.parse(week + 'T00:00:00+08:00');
  return { now, week, prior: date(start - 7 * day), earlier: date(start - 14 * day), start };
}

export function demoResumeTimeline(person, now = Date.now()) {
  const year = new Date(now + 8 * 3_600_000).getUTCFullYear();
  const graduate = person.level === 'graduate';
  const education = person.studentStatus === 'admitted'
    ? `${year + 1}（计划入学）｜示例大学（虚构）｜计算机技术硕士（演示）\n${year - 3}—至今｜示例学院（虚构）｜计算机科学与技术本科`
    : person.studentStatus === 'graduated'
      ? `${year - 5}—${year - 2}｜示例大学（虚构）｜计算机技术硕士\n${year - 9}—${year - 5}｜示例学院（虚构）｜计算机科学与技术本科`
      : graduate
        ? `${year - 2}—至今｜示例大学（虚构）｜计算机技术硕士\n${year - 6}—${year - 2}｜示例学院（虚构）｜计算机科学与技术本科`
        : `${year - 3}—至今｜示例大学（虚构）｜计算机科学与技术本科`;
  return { education, awards: `${year - 1} 年示例可视化挑战赛优秀项目（虚构）` };
}

// Original geometric chart; no person, photo metadata, or third-party image is used.
function chartPng() {
  const width = 480, height = 220, scan = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    let color = [243, 248, 253];
    if (y === 188 && x > 35 && x < 450) color = [113, 139, 162];
    for (let i = 0; i < 4; i++) {
      const left = 70 + i * 96;
      if (x > left && x < left + 24 && y > 188 - [94, 112, 126, 138][i] && y < 188) color = [54, 113, 190];
      if (x > left + 26 && x < left + 50 && y > 188 - [110, 129, 144, 160][i] && y < 188) color = [36, 151, 125];
    }
    const offset = y * (width * 3 + 1) + 1 + x * 3;
    color.forEach((channel, index) => { scan[offset + index] = channel; });
  }
  function chunk(type, bytes) {
    const name = Buffer.from(type), body = Buffer.concat([name, bytes]);
    let crc = 0xffffffff;
    for (const byte of body) { crc ^= byte; for (let i = 0; i < 8; i++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1; }
    const length = Buffer.alloc(4), checksum = Buffer.alloc(4);
    length.writeUInt32BE(bytes.length); checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
    return Buffer.concat([length, body, checksum]);
  }
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header), chunk('IDAT', deflateSync(scan)), chunk('IEND', Buffer.alloc(0))]);
}

function existingDemo(path) {
  if (lstatSync(path).isSymbolicLink()) throw new Error('演示数据库不能是符号链接。');
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const table = db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='demo_metadata'").get();
    const metadata = table && db.prepare('SELECT * FROM demo_metadata WHERE id=1').get();
    if (metadata?.version !== demoVersion) throw new Error('data/demo.sqlite 已存在且不是本工具创建的演示库；不会修改它。');
    return { path, created: false, week: metadata.week, seededAt: metadata.seeded_at };
  } finally { db.close(); }
}

export async function seedDemo({ root = releaseRoot, now = Date.now() } = {}) {
  const base = realpathSync(resolve(root)), directory = join(base, 'data'), path = join(directory, 'demo.sqlite');
  if (existsSync(directory) && lstatSync(directory).isSymbolicLink()) throw new Error('演示数据目录不能是符号链接。');
  if (existsSync(path)) return existingDemo(path);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = join(directory, '.demo-build-' + randomUUID() + '.sqlite');
  const db = new DatabaseSync(temporary);
  const d = demoDates(now), at = offset => iso(now + offset * day), on = offset => date(now + offset * day);
  const ids = {}, rows = [];
  let initialized = false;
  try {
    const schema = createLabServer({ db, autoCalendar: false });
    schema.close();
    const accounts = openAccounts(db);
    const admin = await accounts.createAdmin({ name: '演示管理员', email: 'admin@demo.example.test', password: demoPassword });
    const teachers = [
      await accounts.createTeacher({ name: '沈知衡', email: 'teacher@demo.example.test', password: demoPassword }),
      await accounts.createTeacher({ name: '许云舟', email: 'mentor@demo.example.test', password: demoPassword })
    ];
    ids.admin = admin.id; ids.teachers = teachers.map(user => user.id);
    for (const [index, person] of people.entries()) {
      const user = await accounts.register({ ...person, password: demoPassword, primaryTeacherId: teachers[person.teacher].id,
        studentNumber: person.studentStatus === 'active' ? (person.level === 'graduate' ? '2099000' : '20990000000') + (index + 1) : '',
        relationship: person.secondary === undefined ? 'direct' : 'assisted', advisor: teachers[person.teacher].name,
        major: person.level === 'graduate' ? '计算机技术' : '计算机科学与技术', activities: ['小论文', person.level === 'graduate' ? '研究生毕业论文' : '毕业设计'] });
      if (!person.pending) accounts.reviewStudent(teachers[person.teacher].id, user.id, 'approved');
      if (person.secondary !== undefined) accounts.assignTeachers(admin.id, user.id, { primaryTeacherId: teachers[person.teacher].id, secondaryTeacherId: teachers[person.secondary].id });
      rows.push({ ...person, id: user.id }); ids[person.email.split('@')[0]] = user.id;
    }
    db.exec('BEGIN IMMEDIATE');
    db.prepare('UPDATE accounts SET created_at=?,updated_at=?').run(sqlTime(now - 60 * day), sqlTime(now - day));
    // Approval is part of historical weekly eligibility; keep its synthetic timeline
    // after account creation and before the earliest seeded reporting week.
    db.prepare('UPDATE account_audit SET occurred_at=?').run(sqlTime(now - 59 * day));
    for (const person of rows.filter(person => !person.pending)) {
      db.prepare('UPDATE accounts SET birthday=? WHERE id=?').run('2001-' + on(person.id % 4).slice(5), person.id);
      db.prepare('INSERT INTO welcome_dismissals VALUES(?,?)').run(person.id, at(-2));
    }

    const topics = [
      { owner: ids.student, members: [ids.student, ids.zhou], title: '【演示课题】面向长文本的多模态检索与重排序', stage: 3, venue: 'DemoVision（虚构会议）' },
      { owner: ids.zhou, members: [ids.zhou], title: '【演示课题】模型不确定性的可视化与解释', stage: 5, venue: 'DemoAI（虚构会议）' },
      { owner: ids.chen, members: [ids.chen, ids.xu], title: '【演示课题】实验记录的结构化检索', stage: 2, venue: '' }
    ];
    for (const topic of topics) {
      topic.id = Number(db.prepare('INSERT INTO paper_topics(owner_id,title,abstract,stage,venue,deadline,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)')
        .run(topic.owner, topic.title, '这是一项虚构研究，用于演示问题定义、协作与阶段追踪。我们比较不同采样、检索和可视化策略，使用合成数据评估稳定性。', topic.stage, topic.venue, on(14 + topic.stage), at(-20), at(-1)).lastInsertRowid);
      for (const member of topic.members) db.prepare('INSERT INTO paper_topic_members VALUES(?,?,?)').run(topic.id, member, at(-20));
      for (const point of ['建立可重复的数据划分与评测流程。', '分析长文本与困难样例的误差来源。', '用可视化记录参数和结果之间的关系。']) db.prepare('INSERT INTO paper_topic_points(topic_id,text) VALUES(?,?)').run(topic.id, point);
    }

    const reportInsert = db.prepare('INSERT INTO weekly_reports(student_id,week,first_submitted_at,first_cutoff_at,was_late,revision,draft) VALUES(?,?,?,?,?,?,?)');
    const versionInsert = db.prepare('INSERT INTO weekly_versions(report_id,content,created_at) VALUES(?,?,?)');
    const allReports = [];
    for (const [index, person] of rows.filter(person => person.studentStatus === 'active' && !person.pending).entries()) {
      for (const [weekIndex, week] of [d.earlier, d.prior, d.week].entries()) {
        if (weekIndex === 2 && [2, 4].includes(index)) continue;
        const weekStart = Date.parse(week + 'T00:00:00+08:00');
        const createdAt = Math.min(now - (index + 1) * 45 * 60_000, weekStart + (3 + index % 3) * day);
        const late = index === 1 && weekIndex === 2;
        const cutoff = late ? createdAt - 60_000 : weekStart + 7 * day - 60_000;
        const revision = person.id === ids.student ? 2 : 1;
        const reportId = Number(reportInsert.run(person.id, week, createdAt, cutoff, Number(late), revision, null).lastInsertRowid);
        const topic = topics.find(topic => topic.members.includes(person.id));
        const content = { plan: ['完成 3 组检索参数对照实验', '整理 20 个困难样例与误差原因', '复核数据划分并补充实验记录'],
          reading: '【演示笔记】阅读检索评测方法相关资料，重点记录负例采样、统计区间和可复现配置。下次组会讨论如何避免只看平均指标。',
          experiments: '【仿真实验】比较两个重排序策略；合成样本的指标从 71.2 提高到 74.6。该数值仅用于页面演示，不代表真实研究结果。',
          difficulties: '【演示求助】长文本样例在重排序后效果下降，已经检查截断长度。希望一起核对分组评估脚本与负例采样。',
          relatedTopic: topic ? { id: topic.id, title: topic.title, stage: '验证实验阶段', text: '完成第一轮参数对比，下一步增加困难样例分析。' } : null,
          attachments: [] };
        if (person.id === ids.student && weekIndex === 2) {
          for (const [name, mime, bytes] of [
            ['演示实验记录.md', 'text/markdown; charset=utf-8', Buffer.from('# 演示实验记录\n\n所有结果均为虚构示例。\n\n- 基线：71.2\n- 方案：74.6\n- 下一步：分组误差分析\n')],
            ['演示对照图.png', 'image/png', chartPng()]
          ]) {
            const id = Number(db.prepare('INSERT INTO weekly_attachments(student_id,week,name,mime,bytes,size,created_at) VALUES(?,?,?,?,?,?,?)').run(person.id, week, name, mime, bytes, bytes.length, iso(createdAt)).lastInsertRowid);
            content.attachments.push({ id, name, mime, size: bytes.length });
          }
          content.planRich = { version: 1, blocks: [
            { type: 'paragraph', runs: [{ text: '本周重点', bold: true }, { text: '：复核长文本样例的评估与重排序。' }] },
            ...content.plan.map(text => ({ type: 'bullet', runs: [{ text }] })),
            { type: 'image', attachmentId: content.attachments[1].id }
          ] };
          content.plan = ['本周重点：复核长文本样例的评估与重排序。', ...content.plan];
        }
        const versionIds = [];
        for (let n = 0; n < revision; n++) {
          const next = { ...content, difficulties: n ? content.difficulties + ' 补充：将先按文本长度分组，再核对置信区间。' : content.difficulties };
          versionIds.push(Number(versionInsert.run(reportId, JSON.stringify(next), createdAt + n * 15 * 60_000).lastInsertRowid));
        }
        allReports.push({ person, reportId, week, content, versionIds, createdAt });
        if (weekIndex === 1) for (let task = 0; task < Math.min(2 + index % 2, content.plan.length); task++) {
          db.prepare('INSERT INTO weekly_task_changes(student_id,week,origin_version_id,task_index,done,changed_at) VALUES(?,?,?,?,?,?)')
            .run(person.id, d.week, versionIds[0], task, 1, now - (task + 1) * 60 * 60_000);
        }
      }
    }
    const draft = { plan: ['整理知识图谱实体对齐样例', '准备组会演示'], reading: '【演示草稿】对齐评测的初步笔记。', experiments: '', difficulties: '想请大家推荐小样本评测的方法。', attachments: [], relatedTopic: null };
    reportInsert.run(ids.chen, d.week, null, null, 0, 1, JSON.stringify(draft));
    db.prepare('INSERT INTO weekly_policies(student_id,teacher_id,week,scope,required,weekday,time,created_at) VALUES(?,?,?,?,?,?,?,?)').run(ids.zhou, teachers[1].id, d.week, 'week', 1, 0, '00:01', now - 4 * day);
    db.prepare('INSERT INTO weekly_leaves(student_id,date_from,date_to,reason,note,status,requested_at,reviewer_id,review_note,reviewed_at) VALUES(?,?,?,?,?,?,?,?,?,?)')
      .run(ids.xu, d.week, date(d.start + 6 * day), 'course', '【演示】本周参加集中课程，申请免交。', 'approved', now - 2 * day, teachers[0].id, '演示审批：请在下周补充课程收获。', now - day);
    db.prepare('INSERT INTO weekly_leaves(student_id,date_from,date_to,reason,note,status,requested_at) VALUES(?,?,?,?,?,?,?)')
      .run(ids.chen, on(2), on(3), 'personal', '【演示】需要处理个人事务，提交后等待教师审核。', 'pending', now - 2 * 3_600_000);

    const latest = allReports.filter(item => item.week === d.week);
    const posts = [];
    for (const item of latest) for (const kind of item.person.id === ids.student ? ['plan', 'difficulties'] : ['reading', 'experiments']) {
      const body = kind === 'plan' ? '本周工作计划\n' + item.content.plan.join('\n') : item.content[kind];
      const id = Number(db.prepare('INSERT INTO weekly_publications(student_id,week,kind,body,published_at) VALUES(?,?,?,?,?)').run(item.person.id, d.week, kind, body, iso(item.createdAt + 20 * 60_000)).lastInsertRowid);
      posts.push({ id, author: item.person.id, kind });
    }
    const help = posts.find(post => post.kind === 'difficulties');
    const first = Number(db.prepare('INSERT INTO weekly_publication_comments(publication_id,student_id,parent_id,depth,body,created_at) VALUES(?,?,?,?,?,?)').run(help.id, ids.zhou, null, 1, '可以先固定候选集合，只改变重排序参数。我这边有一份按长度分组的评估模板，可以一起对照。', iso(now - 20 * 60_000)).lastInsertRowid);
    db.prepare('INSERT INTO weekly_publication_comments(publication_id,student_id,parent_id,depth,body,created_at) VALUES(?,?,?,?,?,?)').run(help.id, ids.student, first, 2, '谢谢！我会保留同一批候选，并补充短文本与长文本两组的误差分析。', iso(now - 15 * 60_000));
    db.prepare('INSERT INTO weekly_publication_comments(publication_id,student_id,parent_id,depth,body,created_at) VALUES(?,?,?,?,?,?)').run(help.id, teachers[0].id, null, 1, '建议同时记录截断位置和候选覆盖率。下次组会先讨论最典型的五个样例。', iso(now - 10 * 60_000));
    db.prepare('INSERT INTO weekly_publications(student_id,week,kind,body,published_at) VALUES(?,?,?,?,?)').run(ids.student, d.prior, 'summary', '【历史演示动态】完成检索基线与第一版记录模板，下一步开始误差分析。', at(-7));

    for (const [index, person] of rows.filter(person => !person.pending && person.studentStatus !== 'admitted').entries()) {
      for (const [offset, title, status] of [[2, '整理开题报告与研究计划', 'confirmed'], [7, '提交实验设计与评测方案', 'submitted'], [18, '完成论文初稿与自查', 'open']]) {
        const id = Number(db.prepare('INSERT INTO graduation_tasks(student_id,title,due_date,status,student_at,teacher_id,teacher_at,review_note) VALUES(?,?,?,?,?,?,?,?)').run(person.id, '【演示】' + title, on(offset + index), status, status === 'open' ? null : at(-1), status === 'confirmed' ? teachers[person.teacher].id : null, status === 'confirmed' ? at(-0.5) : null, status === 'confirmed' ? '结构清楚，下一阶段补充误差分析。' : '').lastInsertRowid);
        if (status === 'confirmed') db.prepare('INSERT INTO management_decisions(kind,record_id,actor_id,decision,decided_at,note) VALUES(?,?,?,?,?,?)').run('graduation', id, teachers[person.teacher].id, 'confirmed', at(-0.5), '演示确认记录');
      }
    }
    for (const [student, status] of [[ids.zhou, 'approved'], [ids.student, 'pending']]) {
      db.prepare('INSERT INTO internships(student_id,organization,position,location,start_date,end_date,notes,status,submitted_at,teacher_id,reviewed_at,review_note) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(student, '示例科技（虚构机构）', '算法研究实习生', '演示城市', on(12), on(60), '【演示登记】仅用于展示实习审批与日历，没有真实企业和人事信息。', status, at(-2), status === 'approved' ? teachers[1].id : null, status === 'approved' ? at(-1) : null, status === 'approved' ? '演示审批：请每月记录进展。' : '');
    }
    for (const [index, title, body] of [
      [0, '【演示通知】本周组会：从平均指标走向样例分析', '请每人准备一个成功样例和一个失败样例，记录输入、配置、结果及判断依据。此通知为虚构示例。'],
      [1, '【演示通知】共享计算资源使用约定', '运行长任务前记录实验编号，结束后整理日志和可复现配置。请使用虚构数据体验本演示站。'],
      [2, '【演示通知】新成员入门', '先完善个人资料，再提交第一份周报。需要帮助时，可在周报中勾选发布困难求助。']
    ]) db.prepare('INSERT INTO member_notices(title,body,published_at,updated_at) VALUES(?,?,?,?)').run(title, body, at(-index), at(-index));

    const profile = { name: '研栖演示实验室', centerName: '示例大学 · 计算机学院', englishName: 'LabNest · Research Together',
      intro: '这里展示一个虚构实验室的研究、交流与日常工作。我们关注如何把检索、数据分析和信息服务连接起来，也重视清楚记录问题、分享过程和相互帮助。本站所有人物、成果与日程均为演示数据。',
      research: '网络安全与性能优化｜研究多路径传输、异常检测与可解释的性能分析。\n网络数据感知与分析｜从复杂数据中发现结构，建立可重复的分析与评测流程。\n智能信息服务平台｜探索知识组织、多模态检索和面向用户的信息交互。',
      people: '沈知衡｜演示教师｜多模态检索与评测\n许云舟｜演示教师｜可信机器学习与可视化\n林星遥｜演示研究生｜长文本检索\n周望舒｜演示研究生｜模型解释',
      admissions: '【演示内容】欢迎浏览研究方向和成员公开主页。若用于真实团队，请由管理员和教师替换为经核实的介绍与联系渠道。',
      contact: '演示联系邮箱：contact@demo.example.test（保留域名，不收邮件）', referenceUrl: '' };
    db.prepare('INSERT INTO portal_profile(id,content) VALUES(1,?)').run(JSON.stringify(profile));
    for (const [index, title, category, body] of [
      [0, '【演示动态】从困难样例开始的一次组会', 'lab', '本周的虚构组会围绕三个检索失败样例展开。成员一起检查数据划分、参数和评测脚本，并把讨论结果整理为后续工作计划。'],
      [1, '【演示动态】实验记录模板完成第一轮试用', 'lab', '新的演示模板将研究问题、实验配置、结果与下一步计划放在同一页，便于同学复现和教师反馈。'],
      [2, '【演示笔记】阅读论文时如何记录评测假设', 'reading', '除了结果数字，还记录数据来源、划分方式、对照条件和局限。这里是一篇为演示门户而编写的阅读笔记，没有引用或复制真实论文内容。'],
      [3, '【演示动态】欢迎新同学加入协作讨论', 'lab', '在这个虚构实验室中，问题可以通过周报发布为动态，其他成员和导师可以继续讨论。演示个人主页同时展示研究方向和项目经历。']
    ]) db.prepare('INSERT INTO news(title,category,body,createdAt,updatedAt,eventDate,visibility) VALUES(?,?,?,?,?,?,?)').run(title, category, body, at(-index * 2), at(-index * 2), on(-index * 2), 'public');
    for (const [index, kind, title] of [[0, 'paper', '【虚构成果】长文本多模态检索的样例分析框架'], [1, 'research', '【虚构项目】面向研究过程的协作记录系统'], [2, 'award', '【虚构获奖】示例数据可视化挑战赛一等奖']]) {
      const resultId = Number(db.prepare('INSERT INTO lab_results(kind,title,result_date,notes,detail,url) VALUES(?,?,?,?,?,?)').run(kind, title, on(-index * 10), '仅为页面演示，不是真实论文、项目或获奖。', '成员合作完成问题定义、原型与评测记录。', 'https://example.test/results/' + (index + 1)).lastInsertRowid);
      db.prepare('INSERT INTO lab_result_members VALUES(?,?)').run(resultId, index === 1 ? ids.chen : ids.student);
      db.prepare('INSERT INTO portal_results VALUES(?,?,?,?,?,?)').run(resultId, title, kind, on(-index * 10), 'https://example.test/results/' + (index + 1), '演示成果，展示公开说明、成果类型与成员关联。');
    }
    for (const person of rows.filter(person => !person.pending)) {
      const draft = { title: person.level === 'graduate' ? '计算机技术 · 演示研究生' : '计算机科学与技术 · 演示本科生',
        bio: '【虚构个人介绍】我是' + person.name + '，关注' + person.area + '。目前在练习把研究问题拆解为可验证的实验，并通过公开笔记与同学交流。此页所有经历与成果均为演示资料。',
        research: person.area + '\n可重复的实验记录与样例分析', ...demoResumeTimeline(person, now),
        projects: '多模态检索评测台（演示项目）\n负责实验配置、样例分析和可视化记录。通过合成数据比较不同方案。\n\n研究过程协作面板（演示项目）\n将周报、任务清单与讨论串连接，保留修改历史。',
        publications: '《长文本检索的样例分析实践》（虚构成果，仅供演示）', skills: 'Python · JavaScript · SQL\n数据可视化 · 实验记录 · 信息检索',
        links: '演示项目｜https://example.test/projects\n演示笔记｜https://example.test/notes', publicEmail: person.email };
      const published = person.studentStatus === 'admitted' ? null : JSON.stringify({ name: person.name, major: '计算机技术', ...draft });
      db.prepare('INSERT INTO student_sites VALUES(?,?,?,?,?,?,?)').run(person.id, JSON.stringify(draft), 1, at(-1), published, published ? 1 : null, published ? at(-1) : null);
    }
    db.exec('DELETE FROM conference_subscriptions; DELETE FROM conference_deadlines; DELETE FROM conference_sync;');
    db.prepare('INSERT INTO conference_subscriptions VALUES(?,?,?,1)').run('demo', '虚构会议日程 · 离线演示', demoCalendarUrl);
    const events = demoEvents(now);
    for (const event of events) db.prepare('INSERT INTO conference_deadlines VALUES(?,?,?,?,?,?,?,?)').run('demo', event.uid, event.title, event.date, event.at, 'UTC+08:00', event.link, event.rank);
    db.prepare('INSERT INTO conference_sync VALUES(?,?,?,?)').run('demo', iso(now), iso(now), '');
    db.exec('CREATE TABLE demo_metadata(id INTEGER PRIMARY KEY CHECK(id=1),version TEXT NOT NULL,seeded_at TEXT NOT NULL,week TEXT NOT NULL);');
    db.prepare('INSERT INTO demo_metadata VALUES(1,?,?,?)').run(demoVersion, iso(now), d.week);
    if (db.prepare('PRAGMA foreign_key_check').all().length) throw new Error('演示数据外键校验失败。');
    db.exec('COMMIT');
    initialized = true;
  } catch (error) {
    if (db.isTransaction) db.exec('ROLLBACK');
    throw error;
  } finally {
    db.close();
    if (!initialized && existsSync(temporary)) unlinkSync(temporary);
  }
  chmodSync(temporary, 0o600);
  try {
    // Atomic no-clobber publication: a concurrent seed cannot replace an existing database.
    linkSync(temporary, path);
  } finally { unlinkSync(temporary); }
  return { path, created: true, week: d.week, seededAt: iso(now), accounts: 11, ids };
}

export function demoEvents(now = Date.now()) {
  return [2, 5, 9, 13, 18].map((offset, index) => {
    const localDate = date(now + offset * day);
    return { uid: 'fictional-deadline-' + index, title: ['【演示·非真实DDL】DemoAI 摘要登记', '【演示·非真实DDL】DemoVision 全文提交', '【演示日程】研究方法交流', '【演示·非真实DDL】DemoData 论文提交', '【演示日程】年度实验复盘'][index], date: localDate,
      at: new Date(localDate + 'T23:59:00+08:00').toISOString(), link: 'https://example.test/calendar/' + index, rank: index < 2 ? 'A' : 'B' };
  });
}

export function demoCalendar(now = Date.now()) {
  return ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Lab Management//Fictional Demo//ZH', ...demoEvents(now).flatMap(event => [
    'BEGIN:VEVENT', 'UID:' + event.uid, 'DTSTART:' + event.at.replace(/[-:]/g, '').replace('.000', ''), 'SUMMARY:' + event.title,
    'DESCRIPTION:CCF ' + event.rank + '\\n虚构分级，仅用于演示筛选；不是真实会议或真实截止日期。', 'URL:' + event.link, 'END:VEVENT'
  ]), 'END:VCALENDAR', ''].join('\r\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.length > 2) throw new Error('本脚本不接受数据库路径；只创建当前发布目录下的 data/demo.sqlite。');
  const result = await seedDemo();
  console.log(result.created ? '已创建独立的虚构演示数据。' : '演示库已存在，保留所有现有内容。');
  console.log('演示数据周次：' + result.week + '；仅供本机试用。');
}
