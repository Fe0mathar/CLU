# Windows Security event 5159 is a read-only fallback when BFE event collection is off.
# https://learn.microsoft.com/windows/security/threat-protection/auditing/event-5159
function Get-WfpSecurityBindEvidence([string[]] $FilterIds, [datetime] $Start, [datetime] $End) {
    $hits = [ordered]@{ ipv4Tcp = 0; ipv6Tcp = 0; ipv4Udp = 0; ipv6Udp = 0 }
    $result = [pscustomobject]@{ state = 'INVALID_INPUT'; hits = [pscustomobject]$hits }
    if ($null -eq $FilterIds -or $FilterIds.Count -ne 6 -or
        $Start -eq [datetime]::MinValue -or $End -eq [datetime]::MinValue) {
        return $result
    }

    $beginUtc = $Start.ToUniversalTime()
    $endUtc = $End.ToUniversalTime()
    if ($endUtc -lt $beginUtc -or $endUtc - $beginUtc -gt [timespan]::FromMinutes(15)) {
        return $result
    }

    $unique = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    $invariant = [Globalization.CultureInfo]::InvariantCulture
    foreach ($id in $FilterIds) {
        [uint64] $numericId = 0
        if ($id -cnotmatch '^[1-9][0-9]{0,19}$' -or
            ![uint64]::TryParse($id, [Globalization.NumberStyles]::None, $invariant, [ref]$numericId) -or
            !$unique.Add($id)) {
            return $result
        }
    }

    $v4 = $FilterIds[4]
    $v6 = $FilterIds[5]
    $begin = $beginUtc.ToString('o', $invariant)
    $finish = $endUtc.ToString('o', $invariant)
    [xml] $query = @"
<QueryList>
  <Query Id="0" Path="Security">
    <Select Path="Security">
      *[System[Provider[@Name='Microsoft-Windows-Security-Auditing'] and EventID=5159
        and TimeCreated[@SystemTime &gt;= '$begin' and @SystemTime &lt;= '$finish']]]
      and *[EventData[Data[@Name='FilterRTID']='$v4' or Data[@Name='FilterRTID']='$v6']]
    </Select>
  </Query>
</QueryList>
"@

    # Request one extra record to distinguish a complete result from a truncated one.
    $maxRecords = 256
    try {
        $events = @(Get-WinEvent -FilterXml $query -MaxEvents ($maxRecords + 1) -ErrorAction Stop)
    } catch {
        if ($_.FullyQualifiedErrorId -like 'NoMatchingEventsFound,*') {
            $result.state = 'EMPTY'
        } else {
            $result.state = 'UNAVAILABLE'
        }
        return $result
    }

    try {
        if ($events.Count -gt $maxRecords) {
            $result.state = 'LIMIT'
            return $result
        }
        if ($events.Count -eq 0) {
            $result.state = 'EMPTY'
            return $result
        }

        $namespace = 'http://schemas.microsoft.com/win/2004/08/events/event'
        foreach ($record in $events) {
            $eventText = $record.ToXml()
            if ($eventText.Length -gt 16384) { continue }
            [xml] $eventXml = $eventText
            $fields = @{}
            $duplicate = $false
            foreach ($field in $eventXml.GetElementsByTagName('Data', $namespace)) {
                $name = $field.GetAttribute('Name')
                if ($name -cnotin @('FilterRTID', 'Protocol', 'SourceAddress')) { continue }
                if ($fields.ContainsKey($name)) { $duplicate = $true; break }
                $fields.Add($name, $field.InnerText)
            }
            if ($duplicate -or !$fields.ContainsKey('FilterRTID') -or !$fields.ContainsKey('Protocol') -or
                !$fields.ContainsKey('SourceAddress')) { continue }

            if ($fields.FilterRTID -ceq $v4) {
                $family = 'ipv4'
            } elseif ($fields.FilterRTID -ceq $v6) {
                $family = 'ipv6'
            } else {
                continue
            }
            $source = $fields['SourceAddress']
            if ($family -ceq 'ipv4') {
                if ($source -cne '127.0.0.1') { continue }
            } else {
                [Net.IPAddress] $address = $null
                if ($source -notmatch '^[0-9a-fA-F:]+$' -or
                    ![Net.IPAddress]::TryParse($source, [ref]$address) -or
                    ![Net.IPAddress]::IPv6Loopback.Equals($address)) { continue }
            }
            if ($fields.Protocol -ceq '6') {
                $hits[$family + 'Tcp']++
            } elseif ($fields.Protocol -ceq '17') {
                $hits[$family + 'Udp']++
            }
        }
    } catch {
        $result.state = 'UNAVAILABLE'
        return $result
    } finally {
        foreach ($record in $events) {
            if ($record -is [IDisposable]) { $record.Dispose() }
        }
    }

    $result.hits = [pscustomobject]$hits
    if ($hits.ipv4Tcp + $hits.ipv6Tcp + $hits.ipv4Udp + $hits.ipv6Udp -gt 0) {
        $result.state = 'MATCHED'
    } else {
        $result.state = 'NO_ATTRIBUTION'
    }
    return $result
}
