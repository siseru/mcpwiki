# 拡張（Extensions）

[English](extensions.en.md) | 日本語

拡張は、別のリポジトリと別の AWS スタックで作る画面です。MCPWiki は、その画面のバンドル（JavaScript）を Wiki と同じオリジンで配り、記事の下の枠と、専用の画面に描かせます。

- **既定では OFF です。** 設定がなければ、合成されるテンプレートと `config.json` は、この機能がないときとバイト単位で同じです（`test/extensions.test.ts` で確かめています）。
- 拡張のコードは、Wiki と同じオリジンで、**利用者（管理者を含む）と同じ権限を持って**動きます。そのため、この Wiki の設定に書いたハッシュ（SRI）と一致するバンドルしか、ブラウザは実行しません。詳しくは [docs/security.md](security.md#拡張) を見てください。

## 契約（バージョン 1）

拡張と本体の間で取り決めるのは、次の 3 つだけです。拡張は、本体の内部モジュールを取り込みません。

1. 設定の形（下の「設定」）
2. ホスト API（下の「ホスト API」）
3. 契約バージョン。本体が対応する版の一覧は `src/shared/types.ts` の `EXTENSION_CONTRACTS` です。互換を壊す変更のときだけ、版を上げます

## 設定

環境ごとに、拡張の一覧を書きます。ホストゾーンの設定と同じく、Git には入れません。

| 場所 | 用途 |
|---|---|
| `config/extensions.local.json` | 手元からの配備（Git の管理外。`config/extensions.example.json` をコピーして作ります） |
| シークレット `MCPWIKI_EXTENSIONS` | CI（1 行の JSON）。vars に入れると公開のログに出るため、lint で禁止しています |
| `-c extensions='<json>'` | 一時的な指定 |

```json
{
  "dev": [
    {
      "id": "persona-chat",
      "contract": 1,
      "bucketRegionalDomainName": "personachat-dev-bundles-example.s3.us-west-2.amazonaws.com",
      "script": "persona-chat-3f2a9c1e.js",
      "integrity": "sha384-<base64>",
      "connectSrc": ["wss://abcdefghij.execute-api.us-west-2.amazonaws.com"]
    }
  ],
  "prod": []
}
```

| 項目 | 内容と制約 |
|---|---|
| `id` | `/ext/<id>/` と `/apps/<id>/` のパス。`^[a-z][a-z0-9-]{1,30}$`。重複は不可 |
| `contract` | バンドルが前提とする契約バージョン（本体が対応する版のどれか） |
| `bucketRegionalDomainName` | 拡張のバケットのリージョン別ドメイン（`<bucket>.s3.<スタックのリージョン>.amazonaws.com`）。バンドルは、バケットの中の `ext/<id>/` に置く |
| `script` | バンドルのファイル名。内容のハッシュを名前に含めてください（1 年間キャッシュされます） |
| `integrity` | バンドルの SRI（`sha384-…` か `sha512-…`）。`openssl dgst -sha384 -binary <file> \| openssl base64 -A` で求めます |
| `connectSrc` | バンドルが接続する先（CSP の `connect-src` に足します）。`https://` か `wss://` のホスト名だけで、パス、ポート、ワイルドカード、IP アドレスは書けません。最大 4 件 |

合成のときに値を検証し、外れた値は拒否します（エスケープはしません）。

## 本体が足すもの

拡張が 1 つ以上あると、次の 3 つが変わります。

| 対象 | 変更 |
|---|---|
| CloudFront | 挙動 `/ext/<id>/*` を足します。拡張のバケットを OAC で読み、GET と HEAD だけを受け付け、Wiki と同じセキュリティヘッダを付けます |
| CSP | `connect-src` に `connectSrc` を足します。`script-src 'self'` は変えません |
| `config.json` | `extensions: [{ id, contract, src, integrity }]` を足します。バケットや接続先は、ブラウザに渡しません |

拡張のバケットポリシーは、拡張のスタックが作ります。この Wiki の配信の ARN だけに、`ext/<id>/*` の読み取りを許してください。

```json
{
  "Effect": "Allow",
  "Principal": { "Service": "cloudfront.amazonaws.com" },
  "Action": "s3:GetObject",
  "Resource": "arn:aws:s3:::<bucket>/ext/<id>/*",
  "Condition": { "StringEquals": { "AWS:SourceArn": "arn:aws:cloudfront::<account>:distribution/<distribution-id>" } }
}
```

2 つのスタックは、CloudFormation の参照でつなぎません。互いの値は、設定として渡します。こうすれば、権限が循環しません。

## ホスト API

バンドルは、読み込まれたら 1 回だけ `register` を呼びます。

```js
globalThis.mcpwikiHost.register({
  id: 'persona-chat',          // 設定の id と同じ
  contract: 1,                 // 設定の contract と同じ
  title: 'NPC と話す',          // サイドバーのリンクの文字（任意、40 文字まで）
  articleSlot(ctx, el) { },    // 記事の下の枠に描く（任意）
  page(ctx, el, subpath) { },  // /apps/<id>/... の画面（任意）。subpath は "/" や "/npc/ricardo"
});
```

`id` か `contract` が設定と違う登録は、受け付けません。2 回目以降の登録も無視します。

`ctx` の中身:

| 項目 | 内容 |
|---|---|
| `contract` | 契約バージョン |
| `me` | `{ username, role }` |
| `article` | 記事の画面でだけ渡します。`{ id, type, title, tags, extra, canEdit, ownerName }`。過去の版の画面では、枠を作りません |
| `getAccessToken()` | 本人の Cognito のアクセストークン（期限が近ければ更新済み）。サインアウト済みなら `null`。**拡張自身の API と、この Wiki の API にだけ送ってください** |
| `navigate(path)` | SPA の中の画面遷移 |
| `signal` | 画面を離れると中止される `AbortSignal`。WebSocket やタイマーは、これで閉じてください |

**描く場所と、失敗したとき**

- 記事の下には、拡張ごとに `<section class="ext-slot" data-ext="<id>">` を置きます。何も描かなければ、枠は表示されません。
- 次のときは、その拡張の枠に短い通知を出します。通知は管理者にだけ見え、ほかの利用者には何も見えません。`/apps/<id>/` では、だれにでも見えます。Wiki 本体の表示は、どの場合も止まりません。
  - バンドルを読み込めない（ハッシュの不一致を含む）
  - 15 秒たっても `register` が呼ばれない
  - 契約バージョンが合わない
  - `articleSlot` や `page` が例外を投げた
- サイドバーには「拡張」の見出しの下に、`/apps/<id>/` へのリンクを出します。

**拡張の側で守ること**（Wiki と同じオリジンで動くため）

- `innerHTML` などで HTML の文字列を DOM に入れない。`textContent` で組み立てる。
- トークンを保存しない（`localStorage` にも `sessionStorage` にも書かない）。ログにも出さない。
- `config.json` やほかの拡張の状態に頼らない。

## 配備と外し方

**入れるとき**
1. 拡張のスタックを配備します。バンドルとバケットポリシーが作られます。
2. この Wiki の設定（`MCPWIKI_EXTENSIONS`）に、拡張の項目を書きます。
3. この Wiki を配備し直します。dev は `main` へのマージで、prod はタグと 2 回の承認で反映されます。

**拡張の新しい版を出すとき**
1. 新しいバンドルを、別のファイル名で置きます。
2. 設定の `script` と `integrity` を更新して、この Wiki を配備し直します。

この Wiki が承認した版だけが動きます。

**外すとき**
1. 設定から、その拡張の項目を消します。
2. この Wiki を配備し直します。
3. 拡張のスタックを消します。

すべての拡張を外すと、テンプレートと `config.json` は、この機能がないときと同じに戻ります。
