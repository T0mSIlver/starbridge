import StarbridgeProtocol
import SwiftUI
import UIKit

/**
 * Pages the agent attached for the owner to see before answering, as chips after the context
 * (spec/items.md, "Links"): `linkChip`'s icon and text, as every client shows them (#1577), and
 * an arrow out. Each opens in the browser.
 */
struct LinkChips: View {
    let links: [DecisionLink]
    let project: String

    var body: some View {
        Flow(spacing: Tokens.Spacing.s2) {
            // By scalars: Swift's == would merge canonically equal URLs (#1088).
            ForEach(links, id: \.url.unicodeScalars.description) { link in
                if let url = URL(string: link.url) {
                    Chip(chip: linkChip(url: link.url, title: link.title, project: project), url: url)
                }
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Links from the agent")
    }
}

private struct Chip: View {
    let chip: LinkChip
    let url: URL

    var body: some View {
        Link(destination: url) {
            HStack(spacing: Tokens.Spacing.s2) {
                // An icon the asset catalog lacks draws nothing, so the chip stays plain.
                if let name = chip.icon.map({ "Octicon-\($0.rawValue)" }), UIImage(named: name) != nil {
                    Image(name).resizable().frame(width: 16, height: 16).foregroundStyle(Tokens.Colors.fg2.color)
                }
                Text(chip.label).type(Tokens.Typography.label).lineLimit(1).truncationMode(.tail)
                Image(systemName: "arrow.up.right.square").font(.system(size: 14)).foregroundStyle(Tokens.Colors.fg2.color)
            }
            .foregroundStyle(Tokens.Colors.fg.color)
            .padding(.leading, chip.icon == nil ? Tokens.Spacing.s4 : Tokens.Spacing.s3)
            .padding(.trailing, Tokens.Spacing.s2h)
            .frame(minHeight: Tokens.Spacing.s8)
            .overlay(RoundedRectangle(cornerRadius: Tokens.Radius.sm, style: .continuous).strokeBorder(Tokens.Colors.lineStrong.color))
            .contentShape(Rectangle())
        }
        .accessibilityHint("Opens in the browser")
    }
}

/** Views in rows that wrap, as the web's flex-wrap does: each row left-aligned. */
private struct Flow: Layout {
    let spacing: CGFloat

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let width = proposal.width ?? .infinity
        let rows = rows(subviews, width: width)
        let height = rows.map(\.height).reduce(0, +) + spacing * CGFloat(max(rows.count - 1, 0))
        return CGSize(width: proposal.width ?? rows.map(\.width).max() ?? 0, height: height)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var y = bounds.minY
        for row in rows(subviews, width: bounds.width) {
            var x = bounds.minX
            for (i, size) in zip(row.indices, row.sizes) {
                subviews[i].place(at: CGPoint(x: x, y: y + (row.height - size.height) / 2), proposal: ProposedViewSize(size))
                x += size.width + spacing
            }
            y += row.height + spacing
        }
    }

    private struct Row {
        var indices: [Int] = []
        var sizes: [CGSize] = []
        var width: CGFloat = 0
        var height: CGFloat = 0
    }

    /** Subviews in rows no wider than `width`; one too wide alone is narrowed to it and truncates. */
    private func rows(_ subviews: Subviews, width: CGFloat) -> [Row] {
        var rows: [Row] = []
        var row = Row()
        for (i, view) in subviews.enumerated() {
            var size = view.sizeThatFits(.unspecified)
            if size.width > width { size = view.sizeThatFits(ProposedViewSize(width: width, height: nil)) }
            if !row.indices.isEmpty, row.width + spacing + size.width > width {
                rows.append(row)
                row = Row()
            }
            row.width += (row.indices.isEmpty ? 0 : spacing) + size.width
            row.height = max(row.height, size.height)
            row.indices.append(i)
            row.sizes.append(size)
        }
        if !row.indices.isEmpty { rows.append(row) }
        return rows
    }
}
