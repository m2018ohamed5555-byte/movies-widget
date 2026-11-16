def ok: (.poster_path != null) and ((.overview // "") != "") and ((.adult // false) | not) and ((.popularity // 0) >= 1);

def minmax(f):
  [ .[] | f ] as $vals
  | ( ($vals | min) // 0 ) as $lo
  | ( ($vals | max) // 1 ) as $hi
  | {lo:$lo, hi:$hi};

def norm($lo; $hi; $v):
  if $hi == $lo then 0.5 else ( ($v - $lo) / ($hi - $lo) ) end;

def daysFrom($today):
  ( (.release_date // "1970-01-01") ) as $d
  | ( ($d | strptime("%Y-%m-%d") | mktime) - ($today | strptime("%Y-%m-%d") | mktime) ) / 86400;

def proximity($today):
  daysFrom($today) as $d
  | if $d < 0 then 0
    elif $d <= 14 then 1
    elif $d <= 30 then 0.6
    elif $d <= 60 then 0.3
    else 0 end;

def voteRel:
  ( .vote_count // 0 ) as $vc
  | if $vc < 20 then 0
    else ( (.vote_average // 0) / 10 ) * ( [1, ($vc/200)] | min )
    end;

($trend_week[0] // []) as $tw
| ($trend_day[0] // []) as $td
| ($disc_ant[0] // []) as $da
| ($upcoming[0] // []) as $up

| ($tw | to_entries | map({ (.value.id|tostring): (1 - (.key / ([$tw|length,1]|max))) }) | add // {}) as $wrank
| ($td | map(.id)) as $dayIds

| ( $tw + $td + $da + $up
    | map(select(ok))
    | group_by(.id)
    | map(.[0])
  ) as $pool

| ( $pool | minmax(.popularity // 0) ) as $pm

| ( $pool | map(
      . as $m
      | ($wrank[($m.id|tostring)] // 0) as $trendRank
      | (if ($dayIds | index($m.id)) then 0.15 else 0 end) as $spike
      | ( [ ($trendRank + $spike), 1 ] | min ) as $trendScore
      | ( norm($pm.lo; $pm.hi; ($m.popularity // 0)) ) as $popScore
      | ( $m | proximity($today) ) as $prox
      | ( $m | voteRel ) as $vrel
      | $m + {
          _featScore: (0.45*$popScore + 0.35*$trendScore + 0.10*$vrel + 0.10*$prox),
          _trendingScore: (0.25*$popScore + 0.70*$trendScore + 0.05*$vrel),
          _antScore: (0.55*$popScore + 0.15*$trendScore + 0.10*$vrel + 0.20*$prox),
          _inTrending: ($trendRank > 0 or $spike > 0),
          _isFuture: ( ($m.release_date // "") >= $today )
        }
    )
  ) as $scored

| ( $scored | sort_by(-._featScore) ) as $featSorted
| ( reduce $featSorted[] as $m (
      {picked: [], lastGenre: null};
      if (.picked | length) >= 4 then .
      else
        ($m.genre_ids[0] // -1) as $g
        | if $g == .lastGenre and (.picked|length) > 0 then .
          else { picked: (.picked + [$m]), lastGenre: $g }
          end
      end
    )
  ) as $featPass1
| ( if ($featPass1.picked | length) < 4 then
      ($featPass1.picked | map(.id)) as $have
      | $featPass1.picked + ( $featSorted | map(select(([.id] | inside($have) | not))) | .[0:(4-($featPass1.picked|length))] )
    else $featPass1.picked
    end
  ) as $featured
| ($featured | map(.id)) as $featIds

| ( $scored | map(select(([.id] | inside($featIds) | not))) ) as $poolAfterFeat
| ( $poolAfterFeat | map(select(._inTrending)) | sort_by(-._trendingScore) ) as $trendTier1
| ( if ($trendTier1|length) >= 5 then $trendTier1[0:5]
    else
      ($trendTier1 | map(.id)) as $have2
      | $trendTier1 + ( $poolAfterFeat | map(select(([.id]|inside($have2)|not))) | sort_by(-._trendingScore) | .[0:(5-($trendTier1|length))] )
    end
  ) as $trending
| ($trending | map(.id)) as $trendIds

| ($featIds + $trendIds) as $used2
| ( $scored | map(select(([.id]|inside($used2)|not))) ) as $poolAfterAll
| ( $poolAfterAll | map(select(._isFuture)) | sort_by(-._antScore) ) as $antTier1
| ( if ($antTier1|length) >= 5 then $antTier1[0:5]
    else
      ($antTier1 | map(.id)) as $have3
      | $antTier1 + ( $poolAfterAll | map(select(([.id]|inside($have3)|not))) | sort_by(-._antScore) | .[0:(5-($antTier1|length))] )
    end
  ) as $anticipated

| {
    featured: ($featured | map(.id)),
    trending: ($trending | map(.id)),
    anticipated: ($anticipated | map(.id))
  }
