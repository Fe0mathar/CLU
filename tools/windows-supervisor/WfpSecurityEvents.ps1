# Windows Security event 5159 is a read-only source for WFP blocked bind evidence.
# https://learn.microsoft.com/en-us/previous-versions/windows/it-pro/windows-10/security/threat-protection/auditing/event-5159
function ConvertFrom-WfpSecurityNumber([string] $Value) {
    [uint64] $number = 0
    $invariant = [Globalization.CultureInfo]::InvariantCulture
    if ($Value -cmatch '\A0[xX][0-9A-Fa-f]{1,16}\z') {
        if ([uint64]::TryParse($Value.Substring(2), [Globalization.NumberStyles]::AllowHexSpecifier,
            $invariant, [ref] $number)) { return $number }
    } elseif ($Value -cmatch '\A[0-9]{1,20}\z') {
        if ([uint64]::TryParse($Value, [Globalization.NumberStyles]::None, $invariant, [ref] $number)) {
            return $number
        }
    }
    return $null
}

function Get-WfpSecurityBindEvidence(
    [string[]] $FilterIds,
    [datetime] $Start,
    [datetime] $End,
    [int] $FixturePid,
    [string[]] $BindLayerIds,
    [long] $AfterRecordId = -1,
    [switch] $RequireExactIdentity
) {
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
    $filterScope = "and *[EventData[Data[@Name='FilterRTID']='$v4' or Data[@Name='FilterRTID']='$v6']]"
    $recordScope = ''
    $fieldNames = @('FilterRTID', 'Protocol', 'SourceAddress')
    $provider = 'Microsoft-Windows-Security-Auditing'
    if ($RequireExactIdentity) {
        if ($FixturePid -lt 1 -or $AfterRecordId -lt 0 -or $null -eq $BindLayerIds -or $BindLayerIds.Count -ne 2) {
            return $result
        }
        [uint16] $v4Layer = 0
        [uint16] $v6Layer = 0
        if ($BindLayerIds[0] -cnotmatch '\A[1-9][0-9]{0,4}\z' -or
            $BindLayerIds[1] -cnotmatch '\A[1-9][0-9]{0,4}\z' -or
            ![uint16]::TryParse($BindLayerIds[0], [Globalization.NumberStyles]::None, $invariant, [ref] $v4Layer) -or
            ![uint16]::TryParse($BindLayerIds[1], [Globalization.NumberStyles]::None, $invariant, [ref] $v6Layer) -or
            $v4Layer -eq $v6Layer) { return $result }
        $v4Numeric = ConvertFrom-WfpSecurityNumber $v4
        $v6Numeric = ConvertFrom-WfpSecurityNumber $v6
        $recordScope = "and EventRecordID &gt; " + $AfterRecordId.ToString($invariant)
        # Parse IDs from event fields so a different numeric presentation cannot hide a match.
        $filterScope = ''
        $fieldNames += @('ProcessId', 'LayerRTID')
    }
    $begin = $beginUtc.ToString('o', $invariant)
    $finish = $endUtc.ToString('o', $invariant)
    [xml] $query = @"
<QueryList>
  <Query Id="0" Path="Security">
    <Select Path="Security">
      *[System[Provider[@Name='$provider'] and EventID=5159 $recordScope
        and TimeCreated[@SystemTime &gt;= '$begin' and @SystemTime &lt;= '$finish']]]
      $filterScope
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
            if ($RequireExactIdentity) {
                if ($record.ProviderName -cne $provider -or $record.Id -ne 5159 -or $record.LogName -cne 'Security' -or
                    $null -eq $record.RecordId -or $record.RecordId -le $AfterRecordId -or
                    $record.TimeCreated -isnot [datetime]) { continue }
                $eventUtc = $record.TimeCreated.ToUniversalTime()
                if ($eventUtc -lt $beginUtc -or $eventUtc -gt $endUtc) { continue }
            }
            $eventText = $record.ToXml()
            if ($eventText.Length -gt 16384) { continue }
            [xml] $eventXml = $eventText
            $fields = @{}
            $duplicate = $false
            foreach ($field in $eventXml.GetElementsByTagName('Data', $namespace)) {
                $name = $field.GetAttribute('Name')
                if ($name -cnotin $fieldNames) { continue }
                if ($fields.ContainsKey($name)) { $duplicate = $true; break }
                $fields.Add($name, $field.InnerText)
            }
            if ($duplicate -or !$fields.ContainsKey('FilterRTID') -or !$fields.ContainsKey('Protocol') -or
                !$fields.ContainsKey('SourceAddress')) { continue }

            $filter = $fields['FilterRTID']
            $protocol = $fields['Protocol']
            if ($RequireExactIdentity) {
                if (!$fields.ContainsKey('ProcessId') -or !$fields.ContainsKey('LayerRTID')) { continue }
                $eventPid = ConvertFrom-WfpSecurityNumber $fields['ProcessId']
                if ($null -eq $eventPid -or $eventPid -ne $FixturePid) { continue }
                $layer = ConvertFrom-WfpSecurityNumber $fields['LayerRTID']
                $filter = ConvertFrom-WfpSecurityNumber $filter
                $protocolNumber = ConvertFrom-WfpSecurityNumber $protocol
                if ($null -eq $filter -or $null -eq $layer -or $null -eq $protocolNumber) { continue }
                if ($layer -eq $v4Layer -and $filter -eq $v4Numeric) { $filter = $v4 }
                elseif ($layer -eq $v6Layer -and $filter -eq $v6Numeric) { $filter = $v6 }
                else { continue }
                $protocol = $protocolNumber.ToString($invariant)
            }
            if ($filter -ceq $v4) {
                $family = 'ipv4'
            } elseif ($filter -ceq $v6) {
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
            if ($protocol -ceq '6') {
                $hits[$family + 'Tcp']++
            } elseif ($protocol -ceq '17') {
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
