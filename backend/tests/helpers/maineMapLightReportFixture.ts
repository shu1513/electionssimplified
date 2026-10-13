const id = (letter: string) => `a_${letter.repeat(26)}`;
const filer = (letter: string) => `f_${letter.repeat(26)}`;

export const reportUrl = `https://www.mainecampaignfinancedisclosure.com/public/filers/${filer("p")}/filings/d_${"d".repeat(26)}`;
export function reportFixture(): string {
  const dt = (label: string, value: string) =>
    `<div><dt>${label}</dt><dd>${value}</dd></div>`;
  const time = (value: string) => {
    const months = [
      "January",
      "February",
      "March",
      "April",
      "May",
      "June",
      "July",
      "August",
      "September",
      "October",
      "November",
      "December",
    ];
    const [year, month, day] = value.slice(0, 10).split("-").map(Number);
    return `<time datetime="${value}">${months[month - 1]} ${String(day).padStart(2, "0")}, ${year}</time>`;
  };
  const section = (label: string, body: string) =>
    `<section><h2>${label}</h2><div>${body}</div></section>`;
  const labels = [
    "Balance at the Beginning of the Period",
    "Total Contributions",
    "Total Monetary Contributions",
    "Total In-Kind Contributions",
    "Unitemized Total - Contributions of $200 or Less",
    "Total General Treasury Transfers",
    "Total Bank Interest",
    "Total Expenditures",
    "Total Independent Expenditures",
    "Total Loans Received",
    "Total Debts Owed",
    "Balance at the End of the Period",
    "Loan Balance",
    "Debt Balance",
  ];
  const headers = [
    "Date",
    "Name",
    "Address",
    "Occupation",
    "Employer",
    "Amount",
  ];
  const schedule = (label: string, letter: string, amount: string) =>
    section(
      label,
      `<table><thead><tr>${headers.map((h) => `<th scope="col">${h}</th>`).join("")}</tr></thead><tbody><tr>${[
        `<a href="/public/activities/${id(letter)}">09/18/2026</a>`,
        "Source vendor",
        "",
        "",
        "",
        amount,
      ]
        .map(
          (value, index) => `<td data-label="${headers[index]}">${value}</td>`,
        )
        .join(
          "",
        )}</tr></tbody><tfoot><tr><th colspan="5">Total</th><td>${amount}</td></tr></tfoot></table>`,
    );
  const info =
    dt("Report Name", "End Of Third Quarter 2026") +
    dt("Report Type", "Campaign Finance") +
    dt(
      "Reporting Period",
      time("2026-07-15T00:01:00-04:00") +
        " - " +
        time("2026-09-30T23:59:00-04:00"),
    ) +
    dt("Filer Name", "EXAMPLE PAYER") +
    dt("Filing Status", "Filed") +
    dt("Date Submitted", time("2026-10-05T16:32:15-04:00")) +
    dt("Version of Report", "Amendment 1") +
    dt("Report ID", `d_${"d".repeat(26)}`);
  return `<html><body><h1>End Of Third Quarter 2026 - EXAMPLE PAYER</h1>${section("Filing Information", `<dl>${info}</dl>`)}${section("Filing Summary", `<dl>${labels.map((label) => dt(label, label === "Total Expenditures" ? "$800.00" : label === "Total Independent Expenditures" ? "$100.00" : "$0.00")).join("")}</dl>`)}${schedule("Expenditures", "e", "$1,000.00")}${schedule("Returned Expenditures", "r", "$200.00")}${schedule("Independent Expenditures", "i", "$100.00")}${section("Returned Independent Expenditures", '<em class="NoProvidedData">No returned independent expenditures to report</em>')}</body></html>`;
}
