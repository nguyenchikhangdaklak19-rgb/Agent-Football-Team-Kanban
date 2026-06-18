---
name: UI/UX Design System Skill
description: Design System cho Athena CDP — căn theo MoMo Design System chính thức (https://momodesign.gitbook.io/designsystem). Use when defining global styles, building UI components, or reviewing design consistency.
metadata:
  last_modified: 2026-05-10
  source_of_truth: https://momodesign.gitbook.io/designsystem
  figma_kit: figma.com/design/BC7t97lROz7R6AZuPJ6pbf/UI-Kit
  trigger: design, UI, UX, color, spacing, typography, brand, theme, responsive, layout, card, button, modal
---

# Design Skill — Athena CDP Design System

> **Nguồn chuẩn**: MoMo Design System trên GitBook là source of truth. File này map các token sang Tailwind/CSS để dùng cho web (Athena CDP). Pixel-level specs cho từng component (height, padding, radius theo size) chỉ public ở Figma UI Kit — khi cần dimensions chính xác phải mở Figma.

## Contents
- [Color Tokens](#color-tokens-momo-design-system)
- [Typography](#typography-momo-design-system)
- [Spacing & Radius](#spacing--radius)
- [Component Library Map](#component-library-map)
- [Web Component Patterns (Tailwind)](#web-component-patterns-tailwind)
- [Responsive Design Workflow](#responsive-design-workflow)
- [Adaptive & Accessibility Patterns](#adaptive--accessibility-patterns)
- [Design Principles](#design-principles)
- [Do's and Don'ts](#dos-and-donts)

## Color Tokens (MoMo Design System)

> 38 tokens chính thức. Luôn dùng đúng function token (txt cho chữ, bg cho nền, bd cho viền) — không lẫn lộn.

### Text & Icon (`txt-*`)
| Token | Hex | Tailwind | Dùng cho |
|-------|-----|----------|----------|
| **txt-default** | `#303233` | `text-[#303233]` | Văn bản chính |
| **txt-secondary** | `#484848` | `text-[#484848]` | Văn bản phụ |
| **txt-hint** | `#727272` | `text-[#727272]` | Gợi ý, placeholder |
| **txt-disable** | `#c6c6c6` | `text-[#c6c6c6]` | Văn bản bị vô hiệu |
| **txt-white** | `#ffffff` | `text-[#ffffff]` | Trên nền tối / pink |
| **txt-pink** | `#eb2f96` | `text-[#eb2f96]` | Brand accent |
| **txt-interactive** | `#007aff` | `text-[#007aff]` | Link / action có thể nhấn |
| **txt-highlight** | `#13c2c2` | `text-[#13c2c2]` | Nhấn mạnh phụ (cyan) |
| **txt-success** | `#34c759` | `text-[#34c759]` | Trạng thái thành công |
| **txt-warning** | `#fa541c` | `text-[#fa541c]` | Trạng thái cảnh báo |
| **txt-error** | `#f5222d` | `text-[#f5222d]` | Trạng thái lỗi |

### Background (`bg-*`)
| Token | Hex | Tailwind | Dùng cho |
|-------|-----|----------|----------|
| **bg-default** | `#f2f2f6` | `bg-[#f2f2f6]` | Nền app, container |
| **bg-white** | `#ffffff` | `bg-[#ffffff]` | Card, surface |
| **bg-pressed** | `#dfdfe6` | `bg-[#dfdfe6]` | State pressed |
| **bg-disable** | `#ebebf2` | `bg-[#ebebf2]` | Component disabled |
| **bg-pink** | `#eb2f96` | `bg-[#eb2f96]` | Brand action / CTA primary |
| **bg-tonal** | `#fdeaf4` | `bg-[#fdeaf4]` | Pink tonal — section nhẹ |
| **bg-selected** | `#fef4fa` | `bg-[#fef4fa]` | Item được chọn |
| **bg-interactive** | `#007aff` | `bg-[#007aff]` | Action button (info) |
| **bg-highlight** | `#13c2c2` | `bg-[#13c2c2]` | Highlight chip / tag |
| **bg-success** | `#34c759` | `bg-[#34c759]` | Solid success |
| **bg-warning** | `#fa541c` | `bg-[#fa541c]` | Solid warning |
| **bg-error** | `#f5222d` | `bg-[#f5222d]` | Solid error |

### Border (`bd-*`)
| Token | Hex | Tailwind | Dùng cho |
|-------|-----|----------|----------|
| **bd-default** | `#e8e8e8` | `border-[#e8e8e8]` | Viền chuẩn, divider |
| **bd-surface** | `#f9f9f9` | `border-[#f9f9f9]` | Viền surface mờ |
| **bd-selected** | `#fef4fa` | `border-[#fef4fa]` | Viền item selected |
| **bd-disable** | `#f9f9f9` | `border-[#f9f9f9]` | Viền disabled |
| **bd-primary** | `#eb2f96` | `border-[#eb2f96]` | Viền brand chính |
| **bd-secondary** | `#f7acd5` | `border-[#f7acd5]` | Viền brand phụ |
| **bd-success** | `#34c759` | `border-[#34c759]` | Viền success solid |
| **bd-success-sec** | `#aee9bd` | `border-[#aee9bd]` | Viền success nhạt |
| **bd-warning** | `#fa541c` | `border-[#fa541c]` | Viền warning solid |
| **bd-warning-sec** | `#fdbba4` | `border-[#fdbba4]` | Viền warning nhạt |
| **bd-error** | `#f5222d` | `border-[#f5222d]` | Viền error solid |
| **bd-error-sec** | `#fba7ab` | `border-[#fba7ab]` | Viền error nhạt |
| **bd-interactive** | `#007aff` | `border-[#007aff]` | Viền action solid |
| **bd-interactive-sec** | `#99caff` | `border-[#99caff]` | Viền action nhạt |

## Typography (MoMo Design System)

- **Font family**: `SF Pro Text` (iOS/Android). Web fallback: `-apple-system, BlinkMacSystemFont, 'Inter', 'Segoe UI', sans-serif`.
- **Naming convention**: `[GroupFunction] size_fontweight` (VD: `Headline default_Bold`, `Body s_Regular`).
- **6 nhóm** × **5 sizes** × **3 weights** = 18 tokens chính thức.

### Token Groups
| Group | Mục đích | Ví dụ token |
|-------|----------|-------------|
| **Headline** | Tiêu đề screen / hero | `Headline default_Bold` |
| **Header** | Tiêu đề section / card | `Header m_Bold` |
| **Body** | Nội dung paragraph | `Body s_Regular` |
| **Description** | Mô tả phụ, caption | `Description xs_Regular` |
| **Label** | Nhãn field, badge | `Label xs_Medium` |
| **Action** | Text trong button, link | `Action s_Medium` |

### Sizes & Weights
- **Sizes**: `xxs`, `xs`, `s`, `m`, `default`
- **Weights**: `Bold`, `Medium`, `Regular`

> ⚠️ Pixel values (font-size, line-height) cho từng token chỉ public trên Figma. Khi build web, dùng Tailwind scale gần đúng dưới đây và verify lại với designer.

### Tailwind Mapping (web approximation)
| Token | Tailwind | Use case web |
|-------|----------|---------------|
| `Headline default_Bold` | `text-3xl font-bold tracking-tight` | Page title (H1) |
| `Headline m_Bold` | `text-2xl font-bold tracking-tight` | Section title (H2) |
| `Header m_Bold` | `text-lg font-bold` | Card title |
| `Header s_Bold` | `text-base font-bold` | Sub-card title |
| `Body default_Regular` | `text-base font-normal` | Long-form paragraph |
| `Body s_Regular` | `text-sm font-normal` | Standard body |
| `Description xs_Regular` | `text-xs font-normal text-[#727272]` | Caption / hint |
| `Label xs_Medium` | `text-xs font-medium uppercase tracking-wide` | Field label |
| `Label xxs_Medium` | `text-[10px] font-medium uppercase tracking-widest` | Tiny tag/badge |
| `Action s_Medium` | `text-sm font-medium` | Button text |

## Spacing & Radius

### Spacing Scale (chính thức)
| Loại | Giá trị |
|------|---------|
| **Margin** | `12px` |
| **Gap** (screen/section) | `12px` |
| **Gap** (card/item) | `8px` |
| **Padding card** | `12px` |
| **Padding item** | `8px` |
| **paddingZero** | `0` |
| **Text spacing** (null/small/medium) | `0` / `4px` / `8px` |
| **Extra** (s/m/l/xl) | `32px` / `48px` / `56px` / `64px` |

> Base unit chính: **8px và 12px**. Dùng kết hợp 4 (text), 8, 12, 16, 24, 32, 48, 56, 64.

### Radius (web — approximation)
| Element | Tailwind | Lý do |
|---------|----------|-------|
| Tiny pill / dot | `rounded-full` | Status, badge dot |
| Tag / chip | `rounded-md` (6px) | Match Tag component |
| Input / Button | `rounded-xl` (12px) | Theo Button Foundation |
| Standard card | `rounded-2xl` (16px) | Card content |
| Hero card | `rounded-3xl` (24px) | Khu vực nhấn mạnh |
| Modal / Pop-up | `rounded-[32px]` | Theo Pop-up styling |

### Padding Web Patterns
| Element | Tailwind |
|---------|----------|
| Page container | `p-6 md:p-8 pb-20` |
| Card (item) | `p-4` (~16px, gần `padding item 8` × 2) |
| Card (section) | `p-6` (~24px, gần `padding card 12` × 2) |
| Hero card | `p-8` |
| Button (Large/Medium/Small) | Pixel chính xác trong Figma; web dùng `px-6 py-3` / `px-4 py-2` / `px-3 py-1.5` |

## Component Library Map

> 17 Foundation + 17 Library components chính thức của MoMo. Khi cần dimensions chính xác → mở Figma UI Kit.

### Foundation (chuẩn hóa cấp app)
**Button, Bottom Navigation, Check Box, Empty State, Input, Keyboard, OTP Input, Pagination, Pin, Radio, Switch Toggle, Tag, Title, Toast, Top Navigation, X-banner, Pop Up (deprecated)**

### Library (cấp tổ hợp)
**Avatar, Badge, Calendar, Carousel, Chart, Chip, Collapse, Divider, Information, Selectable Item, Slider, Step, Stepper, Swipe, Time Picker, Tab, Uploader**

### Specs đã confirm public

| Component | Variants | Sizes | Rules |
|-----------|----------|-------|-------|
| **Button** | Primary, Tonal, Outline, Secondary, TextLink, Disable, Danger, Loading | Large, Medium, Small | 2 từ tốt, max 4 từ / 20 ký tự; verb-first; capitalize first letter; KHÔNG ALL-CAPS |
| **Input** | Text, Money, Dropdown, Text Area | — | — |
| **Tag** | Standard, Heavy (high priority) | — | Color hierarchy theo độ ưu tiên |
| **Title** | Large, Medium, Small slots | — | Map sang `Title typo token/l, /m, /xs` |
| **Toast** | — | — | Cách Bottom Nav 12px; Home Indicator 12px (iPhone X+); 50px screen bottom (iPhone 8 / Android không có nav). Stack gap 12px |
| **Top Navigation** | — | Icon `24px`, Image `40px` | Inner margin `12px` |
| **Avatar** | Image, Text initials, Person icon | **24, 32, 40, 56, 72 px** | KHÔNG dùng status indicator với size 24px |
| **Badge** | Dot (S=24px / L), Numeric, Text, Ribbon | — | Numeric chỉ áp dụng object ≥32px; max 2 chữ số → `99+`; Text 2–8 ký tự; Ribbon 2–25 ký tự. Spacing edge: Dot S 4px, Dot L 8px, Numeric/Text overlap 8px, Ribbon 4px. Numeric top-left, Text/Ribbon top-right |
| **Chip** | Default, Dropdown, Remove | — | Anatomy: optional left icon → bg → label (req) → optional right icon. Gap giữa chip = `8px` |

> Pop-up đã bị deprecate trong design system mới. Khi cần dialog → dùng pattern Modal tự build với `rounded-[32px]`, `p-8`, theo MoMo color tokens.

## Web Component Patterns (Tailwind)

> Patterns này map các component MoMo sang web. Khi xung đột với Figma → Figma thắng.

### Card (Standard)
```html
<div class="bg-[#ffffff] border border-[#e8e8e8] rounded-2xl p-6 shadow-sm 
            hover:border-[#eb2f96]/30 transition-all">
  <!-- content -->
</div>
```

### Button — Primary (theo Foundation)
```html
<button class="px-6 py-3 rounded-xl bg-[#eb2f96] text-[#ffffff] font-medium text-sm 
               shadow-lg shadow-pink-100 hover:opacity-90 active:bg-[#dfdfe6]/0
               transform hover:-translate-y-0.5 active:translate-y-0 transition-all">
  Mua ngay
</button>
```

### Button — Tonal
```html
<button class="px-6 py-3 rounded-xl bg-[#fdeaf4] text-[#eb2f96] font-medium text-sm 
               border border-[#f7acd5] hover:bg-[#fef4fa] transition-all">
  Tìm hiểu
</button>
```

### Button — Outline
```html
<button class="px-6 py-3 rounded-xl bg-transparent text-[#303233] font-medium text-sm 
               border border-[#e8e8e8] hover:border-[#eb2f96] hover:text-[#eb2f96] transition-all">
  Hủy
</button>
```

### Button — Disable
```html
<button disabled class="px-6 py-3 rounded-xl bg-[#ebebf2] text-[#c6c6c6] 
                        font-medium text-sm cursor-not-allowed">
  Không khả dụng
</button>
```

### Button — Danger
```html
<button class="px-6 py-3 rounded-xl bg-[#f5222d] text-[#ffffff] font-medium text-sm 
               hover:opacity-90 transition-all">
  Xóa
</button>
```

### Tag (Standard)
```html
<span class="inline-flex items-center gap-1 px-2 py-1 rounded-md 
             bg-[#fdeaf4] text-[#eb2f96] text-xs font-medium">
  Mới
</span>
```

### Tag (Heavy — high priority)
```html
<span class="inline-flex items-center gap-1 px-2 py-1 rounded-md 
             bg-[#eb2f96] text-[#ffffff] text-xs font-bold">
  HOT
</span>
```

### Chip (Default — clickable)
```html
<button class="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full 
               bg-[#ffffff] border border-[#e8e8e8] text-[#303233] text-sm 
               hover:border-[#eb2f96] hover:bg-[#fef4fa] transition-all">
  <span>Filter</span>
</button>
<!-- Gap giữa chip = 8px (gap-2) -->
```

### Badge — Numeric
```html
<div class="relative w-10 h-10">
  <img src="..." class="w-full h-full rounded-full" />
  <span class="absolute -top-1 -right-1 min-w-[18px] h-[18px] px-1 
               bg-[#f5222d] text-[#ffffff] text-[10px] font-bold 
               rounded-full flex items-center justify-center">
    9
  </span>
</div>
```

### Avatar (40px / 56px / 72px)
```html
<!-- Image -->
<img src="..." class="w-10 h-10 rounded-full object-cover" />
<!-- Text initials -->
<div class="w-10 h-10 rounded-full bg-[#fdeaf4] text-[#eb2f96] 
            font-bold text-sm flex items-center justify-center">KN</div>
```

### Input — Text
```html
<label class="block">
  <span class="text-xs font-medium text-[#727272] uppercase tracking-wide mb-1 block">
    Số điện thoại
  </span>
  <input class="w-full px-4 py-3 rounded-xl bg-[#ffffff] border border-[#e8e8e8] 
                text-[#303233] text-base placeholder:text-[#c6c6c6]
                focus:border-[#eb2f96] focus:outline-none focus:ring-2 focus:ring-[#fdeaf4]
                disabled:bg-[#ebebf2] disabled:text-[#c6c6c6]" 
         placeholder="0xxx xxx xxx" />
</label>
```

### Toast
```html
<!-- Cách bottom nav 12px / cách screen bottom 50px nếu không có nav -->
<div class="fixed bottom-[50px] left-1/2 -translate-x-1/2 z-50
            bg-[#303233] text-[#ffffff] px-4 py-3 rounded-xl shadow-2xl
            text-sm font-medium max-w-[90vw]">
  Đã lưu thành công
</div>
```

### Modal (thay cho Pop-up deprecated)
```html
<div class="fixed inset-0 bg-black/40 z-50 flex items-end md:items-center justify-center">
  <div class="bg-[#ffffff] w-full md:w-[480px] rounded-t-[32px] md:rounded-[32px] 
              p-8 max-h-[90vh] overflow-y-auto">
    <h2 class="text-2xl font-bold text-[#303233] tracking-tight mb-3">Tiêu đề</h2>
    <p class="text-sm text-[#484848] mb-6">Mô tả chi tiết...</p>
    <div class="flex gap-3">
      <button class="flex-1 px-4 py-3 rounded-xl border border-[#e8e8e8] text-[#303233] font-medium">Hủy</button>
      <button class="flex-1 px-4 py-3 rounded-xl bg-[#eb2f96] text-[#ffffff] font-medium">Đồng ý</button>
    </div>
  </div>
</div>
```

### Tonal Section (Pink Tonal — bg-tonal)
```html
<div class="bg-gradient-to-br from-[#fdeaf4] to-[#fef4fa] border border-[#f7acd5] 
            rounded-3xl p-8 relative overflow-hidden">
  <div class="absolute top-0 right-0 w-64 h-64 bg-[#eb2f96]/10 
              rounded-full blur-3xl -mr-32 -mt-32 pointer-events-none"></div>
  <!-- Content -->
</div>
```

### Status Feedback (success / warning / error)
```html
<!-- Success — bg + border secondary -->
<div class="bg-[#34c759]/10 border border-[#aee9bd] text-[#34c759] 
            px-4 py-3 rounded-xl text-sm font-medium">
  Giao dịch thành công
</div>
<!-- Warning -->
<div class="bg-[#fa541c]/10 border border-[#fdbba4] text-[#fa541c] 
            px-4 py-3 rounded-xl text-sm font-medium">
  Sắp hết hạn
</div>
<!-- Error -->
<div class="bg-[#f5222d]/10 border border-[#fba7ab] text-[#f5222d] 
            px-4 py-3 rounded-xl text-sm font-medium">
  Có lỗi xảy ra
</div>
<!-- Info / Interactive -->
<div class="bg-[#007aff]/10 border border-[#99caff] text-[#007aff] 
            px-4 py-3 rounded-xl text-sm font-medium">
  Thông tin
</div>
```

### Table Header (Default)
```html
<thead>
  <tr class="bg-[#f2f2f6] border-b border-[#e8e8e8] text-[#727272]">
    <th class="px-6 py-4 text-[10px] font-medium uppercase tracking-widest opacity-80">
      Column Name
    </th>
  </tr>
</thead>
```

### Tooltip / Information
```html
<div class="group relative inline-block">
  <Info size={14} class="text-[#727272] hover:text-[#303233] cursor-help" />
  <div class="invisible group-hover:visible absolute z-50 bottom-full 
              left-1/2 -translate-x-1/2 mb-2 w-48 p-2 bg-[#303233] 
              text-[#ffffff] text-[10px] rounded-md shadow-xl text-center">
    Tooltip text
  </div>
</div>
```

## Responsive Design Workflow

**Task Progress:**
- [ ] **Step 1: Mobile-first** — Design cho màn hình nhỏ nhất trước (`grid-cols-1`)
- [ ] **Step 2: Tablet** — Thêm `md:` (768px+): `md:grid-cols-2`, `md:p-6`
- [ ] **Step 3: Desktop** — Thêm `lg:` (1024px+): `lg:grid-cols-3`, `lg:p-8`
- [ ] **Step 4: Wide screen** — Thêm `xl:` (1280px+) nếu cần: `xl:grid-cols-4`
- [ ] **Step 5: Verify** — Test 3 sizes: 375px / 768px / 1440px

**Breakpoint Decision Tree:**
- **Card grid** → `grid-cols-1 md:grid-cols-2 lg:grid-cols-3`
- **Sidebar + content** → `flex flex-col lg:flex-row`
- **Modal** → `w-full md:w-[480px] lg:w-[600px]` + bottom-sheet trên mobile
- **Table** → `overflow-x-auto` wrapper cho mobile
- **Text content** → `max-w-prose`

## Adaptive & Accessibility Patterns

### Contrast & Readability
- Text trên nền tối: luôn `text-[#ffffff]` (không dùng gray)
- Text trên nền sáng: `text-[#303233]` (default) hoặc `text-[#484848]` (secondary)
- Brand `#eb2f96` trên nền trắng: WCAG AA cho ≥18px (large text)
- KHÔNG dùng `text-[#c6c6c6]` cho body — chỉ cho disabled

### Interactive States
- Default → Hover → Pressed (`bg-[#dfdfe6]` cho neutral) → Disabled (`bg-[#ebebf2]` + `text-[#c6c6c6]`)
- Focus ring: `focus:ring-2 focus:ring-[#fdeaf4] focus:border-[#eb2f96] focus:outline-none`
- Cursor: `cursor-pointer` cho mọi clickable; `cursor-not-allowed` cho disabled

### Semantic HTML
- `<button>` cho action, `<a>` cho navigation, `<input>` cho form
- KHÔNG dùng `<div onClick>` thay button
- Tables: `<thead>`, `<tbody>`, `<th scope="col">`
- Images: luôn có `alt`

### Dark Mode (Prep)
- Chưa implement; design dùng semantic token names → khi cần thêm `dark:` prefix Tailwind dễ dàng

## Design Principles

1. **Function Color Mapping**: Bắt buộc dùng đúng nhóm token (txt/bg/bd) — không lẫn lộn
2. **Hierarchy bằng weight + size, không bằng color**: Headline > Header > Body; Bold > Medium > Regular
3. **Pink là brand accent, không phải nền chính**: bg-pink chỉ cho CTA / badge nhấn; nền section nhẹ → bg-tonal
4. **8/12 base unit**: Mọi spacing là bội số của 4 (text-spacing) hoặc 8/12 (layout)
5. **Component variants có chủ đích**: Primary chỉ 1 trên screen; Tonal/Outline cho secondary; TextLink cho tertiary
6. **Toast & Modal có quy tắc placement**: Toast 12/50px từ bottom; Modal `rounded-[32px]` p-8
7. **Avatar có size discrete**: chỉ 24/32/40/56/72px — không dùng size khác
8. **Status secondary borders**: dùng `bd-*-sec` (nhạt) cho alert/banner, không dùng border solid

## Do's and Don'ts

| ✅ Do | ❌ Don't |
|-------|----------|
| Dùng đúng token theo function (txt/bg/bd) | Lấy color từ nhóm khác (VD `bg-success` cho text) |
| Pink `#eb2f96` cho brand accent | Dùng `#B0006D` cũ hoặc generic blue/red/green |
| `bg-tonal` (`#fdeaf4`) cho section AI/highlight | Plain white cho section cần nổi bật |
| Button verb-first, capitalize first letter | ALL-CAPS hoặc câu dài >4 từ / >20 ký tự |
| Avatar 24/32/40/56/72px | Avatar size tự đặt |
| Status indicator chỉ với avatar ≥32px | Đặt status indicator lên avatar 24px |
| `rounded-2xl` trở lên cho card | `rounded` (4px) hay `rounded-md` cho card |
| `rounded-xl` cho button/input | `rounded-full` cho button thường (chỉ pill chip) |
| Border secondary (`*-sec`) cho alert nhẹ | Border solid full color cho banner mềm |
| Lucide React icons | FontAwesome / Heroicons |
| Verify pixel-level dimensions trên Figma trước khi ship | Đoán giá trị px khi spec chưa rõ |
