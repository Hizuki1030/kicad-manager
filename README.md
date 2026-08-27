# kicad-manager

[SamacSys Library Loader](https://www.samacsys.com/library-loader/) 互換の KiCad 用 CLI ツール。
[Component Search Engine](https://componentsearchengine.com/) からシンボル・フットプリント・3D モデルを検索して、
KiCad プロジェクトのライブラリに直接追加できます。

## Requirements

- Node.js >= 18
- KiCad (7/8/9 で動作確認)

## Install

```bash
git clone https://github.com/Hizuki1030/kicad-manager.git
cd kicad-manager
npm install        # build (tsc) も自動実行
npm link           # kicad-manager コマンドをグローバルに登録
```

## Usage

```bash
# 1) Component Search Engine のアカウントでログイン
#    (~/.config/kicad-manager/config.json に chmod 600 で保存)
kicad-manager login

# 2) プロジェクト作成
#    lib/lib.pretty (フットプリント) と lib/lib.kicad_sym (シンボル) が
#    fp-lib-table / sym-lib-table に自動登録される
kicad-manager create test_project
cd test_project

# 3) ライブラリ検索 (表形式表示・矢印キーで選択、選択行の説明は自動スクロール)
#    下端までスクロールすると自動で次の25件を読み込み (検索中スピナー表示)
kicad-manager search esp32
kicad-manager search esp32 --json      # JSON で結果を出力
kicad-manager search esp32 --limit 100 # 読み込み件数を制限
kicad-manager search esp32 --all       # 制限なし (デフォルト)

# 表の URL 列は "open" リンク (対応ターミナルではクリック可能)。選択中に o キーでブラウザを開ける

# 4) 部品を追加 (シンボル・フットプリント・3D モデルを lib/ に配置)
kicad-manager add esp32s3               # あいまい検索 → 選択
kicad-manager add esp32s3 --manufacturer Espressif
kicad-manager add esp32s3 --all         # 全ページから検索
kicad-manager add --id <SamacSys Part ID>   # 検索をスキップして直接ダウンロード

# その他
kicad-manager list    # プロジェクト内の部品一覧
```

`add` するとシンボルは `lib/lib.kicad_sym` にマージされ、
Footprint プロパティは `lib:<フットプリント名>` に自動で書き換えられます。

## Commands

| Command | Description |
| --- | --- |
| `login` | Component Search Engine の認証情報を保存 |
| `create <name>` | KiCad プロジェクト + プロジェクトライブラリ登録 |
| `search <term>` | CSE を検索してインタラクティブに選択 |
| `add [term]` | 部品を検索してプロジェクトライブラリに追加 |
| `list` | プロジェクト内のシンボル/フットプリント一覧 |

## Environment variables

| Variable | Description |
| --- | --- |
| `CSE_USERNAME` | Component Search Engine のユーザー名 (config より優先) |
| `CSE_PASSWORD` | Component Search Engine のパスワード (config より優先) |

## How it works

1. `search`: CSE の検索ページ (`/search?term=`) をスクレイピングして結果を表形式で表示
2. `add`: `/part-preview/{MPN}/{Manufacturer}?type=footprint` から SamacSys Part ID を取得し、
   `ga/model.php?partID=<id>` (Basic 認証) から ECAD モデルの zip をダウンロード
3. zip 内の `.kicad_sym` / `.kicad_mod` / `.stp` / `.wrl` を `lib/` に展開・マージ

> 非公式ツールです。Component Search Engine の利用規約に従って使用してください。

## License

MIT
