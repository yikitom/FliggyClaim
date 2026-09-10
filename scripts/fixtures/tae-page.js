// TAE expense page reconstructed from the 2026-04-26 console dump.
// Class names are the real hashed CSS-module names from the log.

const field = (label, required, inner) => `
  <div class="field_PlvYD ${required ? "required_3ncpN" : ""}">
    <div class="label_3OUma" style="padding-top: 9px;">${label}<icon class="uxcore-icon uxicon-yiwen-full icon_2F4nj tip_1L-pv"></icon></div>
    <div class="box_2Yds_"><div class="content_2mYN3">${inner}</div></div>
  </div>`;

const calendar = () => `
  <span class="kuma-calendar-picker-input">
    <input readonly placeholder="请选择" class="kuma-input" value>
    <i class="uxcore-icon uxicon-riqi kuma-calendar-trigger-icon"></i>
  </span>`;

const numberInput = () => `
  <span class="numberInputWrapper_cWTb2">
    <input class="kuma-input" type="text" placeholder="请输入" value>
  </span>`;

// Single-select select2 that already shows the report's default currency.
const currencySelect = () => `
  <div class="select_hfqDF kuma-select2-large kuma-select2 kuma-select2-enabled">
    <div class="kuma-select2-selection kuma-select2-selection--single" role="combobox" aria-expanded="false" tabindex="0">
      <div class="kuma-select2-selection__rendered">
        <div unselectable="on" class="kuma-select2-selection__placeholder" style="display: none;">请选择</div>
        <div class="kuma-select2-selection-selected-value" title="SGD (新加坡元）" style="display: block; opacity: 1;">SGD (新加坡元）</div>
        <div class="kuma-select2-search kuma-select2-search--inline" style="display: none;">
          <div class="kuma-select2-search__field__wrap">
            <input autocomplete="off" class="kuma-select2-search__field" value>
            <span class="kuma-select2-search__field__mirror"></span>
          </div>
        </div>
      </div>
      <span class="kuma-select2-arrow" unselectable="on"></span>
    </div>
  </div>`;

// Employee picker — same widget family, its typeahead input IS visible.
const employeeSelect = (multiple) => `
  <div class="people_2ITS4">
    <div class="kuma-employee-search kuma-select2-large kuma-select2 kuma-select2-enabled">
      <div class="kuma-select2-selection kuma-select2-selection--${multiple ? "multiple" : "single"}" role="combobox" aria-expanded="false">
        <div class="kuma-select2-selection__rendered">
          <div unselectable="on" class="kuma-select2-selection__placeholder" style="display: block;">输入姓名/花名/工号搜索</div>
          <ul><li class="kuma-select2-search kuma-select2-search--inline">
            <div class="kuma-select2-search__field__wrap">
              <input autocomplete="off" class="kuma-select2-search__field" value>
              <span class="kuma-select2-search__field__mirror"></span>
            </div>
          </li></ul>
        </div>
      </div>
    </div>
    <div class="people-counter_1lCKQ"></div>
  </div>`;

const citySelect = () => `
  <div class="select_hfqDF kuma-select2-large kuma-select2 kuma-select2-combobox kuma-select2-enabled">
    <div class="kuma-select2-selection kuma-select2-selection--single" role="combobox" aria-expanded="false">
      <div class="kuma-select2-selection__rendered">
        <div unselectable="on" class="kuma-select2-selection__placeholder" style="display: block;">请选择</div>
        <ul><li class="kuma-select2-search kuma-select2-search--inline">
          <div class="kuma-select2-search__field__wrap">
            <input autocomplete="off" class="kuma-select2-search__field" value>
          </div>
        </li></ul>
      </div>
      <span class="kuma-select2-arrow" unselectable="on"></span>
    </div>
  </div>`;

const upload = (id) => `
  <div><span class="attachment-placeholder_3e8SO"></span><span class="upload-component_1BMS9">
    <span class="upload-link-container_GV8IB">
      <span class="upload-link_3XFgK">上传附件</span>
      <input id="${id}" type="file" multiple accept="doc,docx,xls,xlsx,pdf,jpg,jpeg,png" style="display: none;">
    </span><div class="file-list_3t5H9"></div>
  </span></div>`;

const receiptRadio = () => `
  <div class="radio_2dhs9 field_PlvYD required_3ncpN">
    <div class="label_3OUma">收据类型</div>
    <div class="box_2Yds_"><div class="content_2mYN3">
      <label class="kuma-radio-wrapper"><input type="radio" class="kuma-radio" name="receipt" checked><span>有收据</span></label>
      <label class="kuma-radio-wrapper"><input type="radio" class="kuma-radio" name="receipt"><span>无收据</span></label>
    </div></div>
  </div>`;

const buttons = () => `
  <div class="buttons_1XdQw"><div class="buttons-box_3Zb06">
    <button type="button" class="kuma-button kuma-button-primary with-aux_XroAO">保存</button>
    <button type="button" class="kuma-button kuma-button-primary aux_1zE0p"></button>
    <button type="button" class="kuma-button kuma-button-secondary">取消</button>
  </div></div>`;

const mealForm = () => `
  <div></div>
  <div class="form_D3dym fluid_D6uvy">
    ${receiptRadio()}
    ${field("费用发生时间", false, calendar())}
    ${field("公司合餐人", false, employeeSelect(true))}
    ${field("金额", true, numberInput())}
    ${field("币种", true, currencySelect())}
    ${field("详细说明", false, `<div class="text_3-6R7"><textarea class="kuma-textarea" placeholder="请输入" maxlength="100"></textarea><div class="text-shadow_19SQk"></div></div>`)}
    ${field("附件", false, upload("meal-attach"))}
    ${buttons()}
  </div>`;

const hotelForm = () => `
  <div></div>
  <div class="form_D3dym fluid_D6uvy">
    ${receiptRadio()}
    ${field("费用发生城市", true, citySelect())}
    ${field("入住时间", true, calendar())}
    ${field("离店时间", true, calendar())}
    ${field("公司内合住人", false, employeeSelect(true))}
    ${field("间夜数", true, numberInput())}
    ${field("金额", true, numberInput())}
    ${field("币种", true, currencySelect())}
    ${field("详细说明", false, `<div class="text_3-6R7"><textarea class="kuma-textarea" placeholder="请输入" maxlength="100"></textarea></div>`)}
    ${field("收款人", true, employeeSelect(false))}
    ${field("酒店住宿相关凭证", true, upload("hotel-receipt"))}
    ${field("附件", false, upload("hotel-attach"))}
    ${buttons()}
  </div>`;

// The master pane: 新增费用 toolbar + a DIV-BASED grid (no <table>, no ARIA
// grid roles) whose column header is literally 「金额」 and whose rows carry
// readonly kuma-checkbox selectors. This is what the page-wide scope used to
// hand the amount lookup.
const masterPane = () => `
  <div class="master_1qSRP">
    <div class="toolbar_2xKp">
      <button type="button" data-breaking="true" class="kuma-button kuma-button-primary">新增费用</button>
    </div>
    <div class="grid_1kWq">
      <div class="grid-header_2Ld">
        <span class="cell_9aQ"><input type="checkbox" class="kuma-checkbox" readonly value="on"></span>
        <span class="cell_9aQ">费用类型</span>
        <span class="cell_9aQ">费用发生时间</span>
        <span class="cell_9aQ">金额</span>
        <span class="cell_9aQ">币种</span>
        <span class="cell_9aQ">详细说明</span>
      </div>
      <div class="grid-row_3Bn">
        <span class="cell_9aQ"><input type="checkbox" class="kuma-checkbox" readonly value="on"></span>
        <span class="cell_9aQ">差旅-住宿</span>
        <span class="cell_9aQ">2026-03-29</span>
        <span class="cell_9aQ">684.44</span>
        <span class="cell_9aQ">CNY</span>
        <span class="cell_9aQ">深圳酒店</span>
      </div>
    </div>
  </div>`;

/** @param {"meal"|"hotel"|"skeleton"|"picker"} kind */
export function pageHtml(kind) {
  let drawer;
  if (kind === "picker") {
    drawer = `<div class="detail_1KqLf"><div class="box_34vL-">
      <div class="head_10iVC">选择费用类型</div>
      <div class="cascade_1x"><li title="差旅-餐费" class=""><div class="cascade-item_c1ck5">差旅-餐费</div></li>
      <li title="差旅-住宿" class=""><div class="cascade-item_c1ck5">差旅-住宿</div></li></div>
    </div></div>`;
  } else if (kind === "skeleton") {
    // Drawer mounted, schema not back yet: 保存 exists, fields do not.
    drawer = `<div class="detail_1KqLf"><div class="box_34vL- details_busmF">
      <div class="head_10iVC">差旅-住宿</div>
      <div class="content_3HM_U"><div class="loading_2kd"></div>${buttons()}</div>
    </div></div>`;
  } else {
    drawer = `<div class="detail_1KqLf"><div class="box_34vL- details_busmF">
      <div class="head_10iVC">${kind === "hotel" ? "差旅-住宿" : "差旅-餐费"}</div>
      <div class="content_3HM_U">${kind === "hotel" ? hotelForm() : mealForm()}</div>
    </div></div>`;
  }
  return `<!doctype html><html><body>
    <div class="content_3-5bv">
      ${masterPane()}
      <div class="spliter_3Ng16"></div>
      ${drawer}
    </div>
  </body></html>`;
}
