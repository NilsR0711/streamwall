import { type JSX } from 'preact'
import { useCallback } from 'preact/hooks'
import {
  type InvitableRole,
  inviteLink,
  type LocalStreamData,
  roleCan,
  type StreamData,
  type StreamwallRole,
  type StreamwallState,
} from 'streamwall-shared'
import { styled } from 'styled-components'
import { AuthTokenLine, CreateInviteInput } from '../AccessPanel.tsx'
import { type Invite } from '../invite.ts'
import { Stack } from '../layout.tsx'
import {
  CreateCustomStreamInput,
  CustomStreamInput,
  StreamList,
} from '../Sidebar.tsx'
import { StyledDataContainer } from '../StyledButton.tsx'

/**
 * The right-hand stream list column: the filter box, the four categorized
 * stream lists (favorites/viewing/live/offline), custom-stream management, and
 * the access/invite panel. Extracted from ControlUI's composition root
 * unchanged (issue #393).
 */
export function ControlSidebar({
  role,
  isConnected,
  streamFilter,
  onStreamFilterChange,
  favoriteStreams,
  wallStreams,
  liveStreams,
  otherStreams,
  favoritesSet,
  onClickId,
  onToggleFavorite,
  customStreams,
  onChangeCustomStream,
  onDeleteCustomStream,
  authState,
  newInvite,
  onCreateInvite,
  onDeleteToken,
}: {
  role: StreamwallRole | null
  isConnected: boolean
  streamFilter: string
  onStreamFilterChange: JSX.InputEventHandler<HTMLInputElement>
  favoriteStreams: StreamData[]
  wallStreams: StreamData[]
  liveStreams: StreamData[]
  otherStreams: StreamData[]
  favoritesSet: ReadonlySet<string>
  onClickId: (streamId: string) => void
  onToggleFavorite: (url: string) => void
  customStreams: StreamData[]
  onChangeCustomStream: (url: string, customStream: LocalStreamData) => void
  onDeleteCustomStream: (url: string) => void
  authState: StreamwallState['auth'] | undefined
  newInvite: Invite | undefined
  onCreateInvite: (args: { name: string; role: InvitableRole }) => void
  onDeleteToken: (tokenId: string) => void
}) {
  const preventLinkClick = useCallback((ev: Event) => {
    ev.preventDefault()
  }, [])

  // Favoriting is hidden entirely for roles that can't add favorites, matching
  // the previous inline gating in ControlUI.
  const toggleFavoriteHandler = roleCan(role, 'add-favorite')
    ? onToggleFavorite
    : undefined

  return (
    <Stack className="stream-list" $scroll={true} $minHeight={200}>
      {
        // Keyed on `role` (persists across a reconnect, see
        // `StreamwallConnection`) rather than `isConnected`, so a brief
        // disconnect dims the last-known list instead of replacing it with
        // "loading..." (issue #37). Only the very first load, before any
        // state has ever arrived, shows the loading placeholder.
      }
      <StyledDataContainer $isConnected={isConnected}>
        {role != null ? (
          <div>
            <input
              className="filter-input"
              onChange={onStreamFilterChange}
              value={streamFilter}
              placeholder="Filter streams…"
            />
            <h3>
              Favorites <span className="ct">{favoriteStreams.length}</span>
            </h3>
            <StreamList
              rows={favoriteStreams}
              disabled={!roleCan(role, 'mutate-state-doc')}
              onClickId={onClickId}
              favorites={favoritesSet}
              onToggleFavorite={toggleFavoriteHandler}
            />
            <h3>
              Viewing <span className="ct">{wallStreams.length}</span>
            </h3>
            <StreamList
              rows={wallStreams}
              disabled={!roleCan(role, 'mutate-state-doc')}
              onClickId={onClickId}
              favorites={favoritesSet}
              onToggleFavorite={toggleFavoriteHandler}
            />
            <h3>
              Live <span className="ct">{liveStreams.length}</span>
            </h3>
            <StreamList
              rows={liveStreams}
              disabled={!roleCan(role, 'mutate-state-doc')}
              onClickId={onClickId}
              favorites={favoritesSet}
              onToggleFavorite={toggleFavoriteHandler}
            />
            <h3>
              Offline / Unknown{' '}
              <span className="ct">{otherStreams.length}</span>
            </h3>
            <StreamList
              rows={otherStreams}
              disabled={!roleCan(role, 'mutate-state-doc')}
              onClickId={onClickId}
              favorites={favoritesSet}
              onToggleFavorite={toggleFavoriteHandler}
            />
          </div>
        ) : (
          <div>loading...</div>
        )}
        {roleCan(role, 'update-custom-stream') &&
          roleCan(role, 'delete-custom-stream') && (
            <>
              <h2>Custom Streams</h2>
              <div>
                {/*
                  Keyed by `link` (each custom stream's stable id) rather
                  than array index, so deleting an earlier entry doesn't
                  shift later entries onto a different DOM node mid-edit.
                */}
                {customStreams.map(({ link, label, kind }) => (
                  <CustomStreamInput
                    key={link}
                    link={link}
                    label={label}
                    kind={kind}
                    onChange={onChangeCustomStream}
                    onDelete={onDeleteCustomStream}
                  />
                ))}
                <CreateCustomStreamInput onCreate={onChangeCustomStream} />
              </div>
            </>
          )}
        {(roleCan(role, 'create-invite') || roleCan(role, 'delete-token')) &&
          authState && (
            <>
              <h2>Access</h2>
              <div>
                <CreateInviteInput onCreateInvite={onCreateInvite} />
                <h3>Invites</h3>
                {newInvite && (
                  <StyledNewInviteBox>
                    Invite link created:{' '}
                    <a
                      href={inviteLink({
                        tokenId: newInvite.tokenId,
                        secret: newInvite.secret,
                      })}
                      onClick={preventLinkClick}
                    >
                      "{newInvite.name}"
                    </a>
                  </StyledNewInviteBox>
                )}
                {authState.invites.map(({ tokenId, name, role }) => (
                  <AuthTokenLine
                    key={tokenId}
                    id={tokenId}
                    name={name}
                    role={role}
                    onDelete={onDeleteToken}
                  />
                ))}
                <h3>Sessions</h3>
                {authState.sessions.map(({ tokenId, name, role }) => (
                  <AuthTokenLine
                    key={tokenId}
                    id={tokenId}
                    name={name}
                    role={role}
                    onDelete={onDeleteToken}
                  />
                ))}
              </div>
            </>
          )}
      </StyledDataContainer>
    </Stack>
  )
}

const StyledNewInviteBox = styled.div`
  display: block;
  padding: 10px 12px;
  margin: 8px 0;
  border-radius: var(--r-md);
  background: color-mix(in srgb, var(--ok) 14%, transparent);
  border: 1px solid color-mix(in srgb, var(--ok) 45%, transparent);
  color: var(--text);
  font-size: 13px;
`
