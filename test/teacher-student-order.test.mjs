import test from 'node:test';
import assert from 'node:assert/strict';
import { teacherPage } from '../src/views.mjs';

const state = {
  user: { id: 1, name: '名单验收教师', role: 'teacher' },
  path: '/teacher', csrf: 'isolated-student-list-token', pendingCount: 2,
  siteName: '学生名单测试', photoOwners: new Set(), profileChanges: new Map()
};

function student(id, name, reviewStatus, extra = {}) {
  return Object.freeze({ id, name, reviewStatus, level: 'graduate', studentStatus: 'active',
    major: '计算机', studentNumber: '20260001', relationship: 'direct', advisor: '',
    activities: ['小论文'], email: `student-${id}@list.example`, phone: '', birthday: '',
    reviewReason: '', ...extra });
}

// Mimic the existing newest-first account order; older pending applications still need to move up.
const students = Object.freeze([
  student(50, '已审核其他学生', 'approved', { level: 'undergraduate' }),
  student(40, '李同学', 'pending'),
  student(30, '王同学', 'rejected', { activities: ['竞赛'] }),
  student(20, '陈同学', 'approved'),
  student(10, '赵同学', 'pending')
]);

function render(query = new URLSearchParams(), rows = students) {
  return teacherPage(state, rows, [], query);
}

function records(html) {
  return [...html.matchAll(/<li\b[^>]*\bdata-student-id="(\d+)"[^>]*\bdata-review-status="([^"]+)"[^>]*>([\s\S]*?)<\/li>/g)]
    .map(([, id, status, body]) => ({ id: Number(id), status, body }));
}

test('教师名单将所有待审核申请置顶，同组保持原顺序且不改变调用者提供的学生数组', () => {
  const originalOrder = students.map(row => row.id);
  const html = render();
  assert.deepEqual(records(html).map(row => row.id), [40, 10, 50, 30, 20]);
  assert.deepEqual(students.map(row => row.id), originalOrder);
  assert.match(html, /2 人待审核/);
  assert.match(html, /class="desk-students-scroll"[^>]*role="region"[^>]*aria-label="学生管理名单"[^>]*tabindex="0"/);
});

test('姓名及参与事项筛选后的结果仍待审优先，审核状态筛选不会混入其他学生', () => {
  const matched = render(new URLSearchParams({ name: '同学', activity: '小论文' }));
  assert.deepEqual(records(matched).map(row => row.id), [40, 10, 20]);
  assert.doesNotMatch(matched, /data-student-id="(?:50|30)"/);

  const approved = render(new URLSearchParams({ reviewStatus: 'approved' }));
  assert.deepEqual(records(approved).map(row => row.id), [50, 20]);
  assert.ok(records(approved).every(row => row.status === 'approved'));
  assert.match(approved, /2 人待审核/); // The header remains a count of all pending applications.

  const onlyPending = render(new URLSearchParams({ reviewStatus: 'pending' }));
  assert.deepEqual(records(onlyPending).map(row => row.id), [40, 10]);
});

test('排序后保留对应学生的审核与状态入口，空名单及无匹配结果有明确提示', () => {
  for (const row of records(render())) {
    if (row.status === 'pending') {
      assert.match(row.body, new RegExp(`action="/teacher/students/${row.id}/review" method="post"`));
      assert.match(row.body, /name="csrf" value="isolated-student-list-token"/);
      assert.match(row.body, /name="decision" value="approved"/);
      assert.match(row.body, /name="decision" value="rejected"/);
    } else {
      assert.doesNotMatch(row.body, /name="decision"/);
      if (row.status === 'approved') {
        assert.match(row.body, new RegExp(`action="/teacher/students/${row.id}/status" method="post"`));
      }
    }
  }

  const noMatch = render(new URLSearchParams({ name: '不存在的学生' }));
  assert.equal(records(noMatch).length, 0);
  assert.match(noMatch, /没有符合条件的学生。/);
  assert.doesNotMatch(noMatch, /class="desk-students-scroll"/);

  const empty = render(new URLSearchParams(), []);
  assert.equal(records(empty).length, 0);
  assert.match(empty, /暂无学生申请。/);
  assert.match(empty, /0 人待审核/);
});
