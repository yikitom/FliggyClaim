# FliggyClaim 报销助手

Chrome 扩展：把票据（PDF / 图片）解析成报销明细，再自动填进 TAE 报销系统。
面向使用者的安装说明见 [INSTALL.txt](INSTALL.txt)，隐私说明见 [PRIVACY.md](PRIVACY.md)。
这份文档是给改代码的人看的。

## 结构

```
popup/          侧边栏：拖入文件 → 解析 → 逐条核对/编辑 → 导入
lib/parser.js   解析层：pdf.js 取文本 / tesseract OCR，再用关键词+正则猜
                type / date / amount / currency / city / nights
content/        注入 TAE 页面：点「新增费用」→ 选类目 → 填表 → 保存
background/     service worker：打开侧边栏、装扩展后补注入 content script
scripts/        构建（build.sh）与测试（test-*.mjs）
```

数据流：`popup` 解析出 records → `chrome.tabs.sendMessage(FLIGGY_FILL)` →
`content` 按 record 逐条开抽屉填表。附件是把 `File` 读成 base64 一起发过去，
在 content 侧重新组装成 `File` 塞进 `<input type="file">`。

## 一条铁律：没校验过就不许报成功

这个扩展最贵的 bug 不是"填不进去"，而是**填错了还报成功**——用户以为导完了，
实际报销单里是空金额、错币种、没附件。2026-04-26 那份控制台日志里三条记录
全部 ✓，但：金额写进了勾选框的 value 属性、写进了币种下拉的搜索框、日期压根
没写、币种停在报销单默认的 SGD。

所以现在的约定是：

* **写完就回读。** 每次写值之后重新定位元素再读回来比对，不要相信"我刚给这个
  节点赋过值"——如果定位错了，赋值和回读是同一个错节点，校验自证自明。
* **必填字段写不进去就抛错，取消这条，不保存。** 一条空金额的脏数据比一条
  失败记录糟得多：失败可以重来，脏数据要手工去 TAE 里找出来删。
* **失败信息要点名字段。**「等待 drawer close 超时」对用户毫无价值；
  `describeSaveFailure()` 会说清是哪个必填项还空着。
* **定位控件只在标签自己那一行内找。** 跨行找控件是所有"填到隔壁字段"的
  根源；见 `findControlByLabel` 的注释。

## 测试

```bash
npm i            # 只装 jsdom，扩展本身不依赖 npm
npm test
```

| 套件 | 跑什么 | 依赖 |
|---|---|---|
| `test-parser` | `lib/parser.js` 的纯函数启发式 | 无，裸 node 即可 |
| `test-form-fill` | `content.js` 在还原出来的 TAE DOM 上定位/填写 | jsdom |
| `test-popup` | 真实的 `popup.html` + `popup.js` | jsdom |

`scripts/fixtures/tae-page.js` 是按那份控制台日志还原的 TAE DOM（连 CSS-module
的 hash 类名都是真的），并模拟了三个关键控件的真实行为：

* `installCalendarBehavior` —— 只读输入框 + 日历弹层，**只有点开弹层选日期才
  能改值**（程序化赋值会被丢弃，和 React 受控组件一致）；
* `installComboBehavior` —— select2 的选项列表只在打开时存在、渲染在 document
  层、typeahead 输入框关闭时是 `display:none`；
* `installUploadBehavior` —— 上传有进度、可能失败、可能残留进度条。

改 `content.js` 的定位逻辑时，先在 fixture 里把真实 DOM 补进去再改代码——
`FC_SRC=<旧文件> node scripts/test-form-fill.mjs` 可以拿老版本跑同一套断言，
用来确认一个 bug 确实被复现了。

## 发布

```bash
npm run build     # 读 manifest.json 的 version，产出 dist/fliggyclaim-<version>[-webstore].zip
```

版本号只有 `manifest.json` 一处（`package.json` 故意不带 version）。
`-webstore.zip` 去掉了 `key` 字段，是传应用商店用的那个。
